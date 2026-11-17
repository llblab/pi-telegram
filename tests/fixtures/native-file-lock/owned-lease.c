/*
 * Qualification fixture for environment-owned kernel leases; not a runtime adapter.
 * Zones: native resource lifetime, disposable validation
 * Not a production backend, stable API, migration or recovery implementation.
 * Linux build: cc -std=c11 -shared -fPIC -I <public-node-include> owned-lease.c -o owned-lease.node
 * Darwin build: use -bundle -undefined dynamic_lookup instead of -shared.
 * Windows build: public Node SDK/MSVC, linking node.lib and advapi32.lib.
 */
#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <wchar.h>
#define LEASE_FIXTURE_KIND "win32-owned-lease-prototype-v1"
#define CLOSE_OPERATION "CloseHandle"
typedef HANDLE native_file;
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
typedef int native_file;
#define CLOSE_OPERATION "close"
#if defined(__linux__)
#define LEASE_FIXTURE_KIND "linux-owned-lease-prototype-v1"
#elif defined(__APPLE__) && defined(__MACH__)
#define LEASE_FIXTURE_KIND "darwin-owned-lease-prototype-v1"
#include <sys/file.h>
#else
#error "This ownership prototype supports Linux, Darwin and Windows only"
#endif
#endif
#include <node_api.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct owner owner;
typedef struct lease lease;
struct owner { lease *head; size_t references; bool closing; };
struct lease { owner *context; lease *previous, *next; native_file file; bool spent; };
static const napi_type_tag lease_tag = { 0x50744c6561736531ULL, 0xa3d7c1196b8e25f0ULL };

static napi_value fail(napi_env env, const char *code, const char *message) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, code, message);
  return NULL;
}
static napi_value api_failure(napi_env env) {
  return fail(env, "ERR_LEASE_NAPI", "Owned-lease prototype N-API operation failed");
}
static napi_value system_failure(napi_env env, uint32_t number, const char *operation) {
  napi_value message, error, value;
  char text[256];
#if defined(_WIN32)
  char reason[192];
  if (!FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL,
      number, 0, reason, (DWORD)sizeof(reason), NULL))
    snprintf(reason, sizeof(reason), "Win32 error %lu", (unsigned long)number);
  const char *field = "win32Code";
  snprintf(text, sizeof(text), "Owned-lease %s failed: %s", operation, reason);
#else
  const char *field = "errno";
  snprintf(text, sizeof(text), "Owned-lease %s failed: %s", operation, strerror((int)number));
#endif
  if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, NULL, message, &error) != napi_ok ||
      napi_create_uint32(env, number, &value) != napi_ok ||
      napi_set_named_property(env, error, field, value) != napi_ok ||
      napi_create_string_utf8(env, operation, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, error, "syscall", value) != napi_ok) return api_failure(env);
  napi_throw(env, error);
  return NULL;
}
/* Spend before close: an error need not preserve descriptor ownership, so retrying
 * the number could close a successor. Error retirement remains unqualified; no retry. */
static uint32_t close_file(native_file file) {
#if defined(_WIN32)
  return CloseHandle(file) ? 0 : GetLastError();
#else
  return close(file) == 0 ? 0 : (uint32_t)errno;
#endif
}
static uint32_t close_once(lease *value) {
  if (value->spent) return 0;
  const native_file file = value->file;
  value->spent = true;
  return close_file(file);
}
static void finalize_lease(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  lease *value = data;
  owner *context = value->context;
#ifndef OWNED_LEASE_SUPPRESS_TEARDOWN
  (void)close_once(value);
#endif
  if (value->previous) value->previous->next = value->next;
  else context->head = value->next;
  if (value->next) value->next->previous = value->previous;
  context->references--;
  free(value);
  if (context->closing && context->references == 0) free(context);
}
static void cleanup_environment(void *data) {
  owner *context = data;
  context->closing = true;
#ifndef OWNED_LEASE_SUPPRESS_TEARDOWN
  for (lease *value = context->head; value; value = value->next) (void)close_once(value);
#endif
  /* Wrapped-object finalization may precede or follow environment cleanup. Keep the
   * context alive until both the hook and all outstanding finalizers have finished. */
  if (context->references == 0) free(context);
}
#if defined(_WIN32)
/* A deliberately narrow qualification policy, not a general Windows ACL model.
 * Current process user, SYSTEM and Administrators may have effective allow ACEs;
 * unknown granting forms/principals fail closed. Ancestor/remote ACLs stay unqualified. */
static uint32_t private_acl(native_file file, bool *admitted) {
  *admitted = false;
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();
  DWORD size = 0;
  (void)GetTokenInformation(token, TokenUser, NULL, 0, &size);
  if (!size) { const DWORD error = GetLastError(); (void)CloseHandle(token); return error; }
  TOKEN_USER *user = malloc(size);
  if (!user) { (void)CloseHandle(token); return ERROR_NOT_ENOUGH_MEMORY; }
  if (!GetTokenInformation(token, TokenUser, user, size, &size)) {
    const DWORD error = GetLastError(); (void)CloseHandle(token); free(user); return error;
  }
  (void)CloseHandle(token);
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PACL acl = NULL;
  DWORD error = GetSecurityInfo(file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    NULL, NULL, &acl, NULL, &descriptor);
  if (error != ERROR_SUCCESS) { free(user); return error; }
  bool allowed = acl != NULL;
  for (DWORD index = 0; allowed && index < (DWORD)acl->AceCount; index++) {
    void *raw = NULL;
    if (!GetAce(acl, index, &raw)) { error = GetLastError(); allowed = false; break; }
    ACE_HEADER *header = raw;
    if (header->AceFlags & INHERIT_ONLY_ACE) continue;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) { allowed = false; break; }
    PSID sid = &((ACCESS_ALLOWED_ACE *)raw)->SidStart;
    allowed = EqualSid(user->User.Sid, sid) || IsWellKnownSid(sid, WinLocalSystemSid) ||
      IsWellKnownSid(sid, WinBuiltinAdministratorsSid);
  }
  (void)LocalFree(descriptor); free(user);
  *admitted = allowed;
  return error;
}
#endif
static napi_value try_acquire(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0;
  napi_value argument;
  napi_valuetype type;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, &argument, NULL, &data) != napi_ok) return api_failure(env);
  owner *context = data;
  if (context->closing) return fail(env, "ERR_LEASE_ENV", "Prototype environment is closing");
  if (argc != 1 || napi_typeof(env, argument, &type) != napi_ok || type != napi_string)
    return fail(env, "ERR_LEASE_PATH", "An absolute existing anchor path is required");
#if defined(_WIN32)
  _Static_assert(sizeof(wchar_t) == sizeof(char16_t), "Windows UTF-16 representation");
  if (napi_get_value_string_utf16(env, argument, NULL, 0, &length) != napi_ok) return api_failure(env);
  wchar_t *path = malloc((length + 1) * sizeof(*path));
  if (!path) return fail(env, "ERR_LEASE_MEMORY", "Cannot allocate prototype anchor path");
  if (napi_get_value_string_utf16(env, argument, (char16_t *)path, length + 1, &length) != napi_ok) {
    free(path); return api_failure(env);
  }
  const bool drive = length >= 3 && ((path[0] >= L'A' && path[0] <= L'Z') ||
    (path[0] >= L'a' && path[0] <= L'z')) && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
  const bool unc = length >= 3 && path[0] == L'\\' && path[1] == L'\\';
  if ((!drive && !unc) || wcslen(path) != length) {
    free(path); return fail(env, "ERR_LEASE_PATH", "Anchor path must be absolute and contain no NUL");
  }
  /* OPEN_EXISTING, non-inheritable, no reparse following or asynchronous wait. */
  const native_file file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  const DWORD open_error = GetLastError();
  free(path);
  if (file == INVALID_HANDLE_VALUE) return system_failure(env, open_error, "CreateFileW");
  BY_HANDLE_FILE_INFORMATION identity;
  if (!GetFileInformationByHandle(file, &identity)) {
    const DWORD error = GetLastError(); (void)close_file(file); return system_failure(env, error, "GetFileInformationByHandle");
  }
  SetLastError(ERROR_SUCCESS);
  const DWORD kind = GetFileType(file);
  const DWORD kind_error = GetLastError();
  if (kind == FILE_TYPE_UNKNOWN && kind_error != ERROR_SUCCESS) {
    (void)close_file(file); return system_failure(env, kind_error, "GetFileType");
  }
  if (kind != FILE_TYPE_DISK || identity.nNumberOfLinks != 1 ||
      (identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
    (void)close_file(file); return fail(env, "ERR_LEASE_ANCHOR", "Anchor must be a single-link regular file without a reparse point");
  }
  bool admitted = false;
  const uint32_t acl_error = private_acl(file, &admitted);
  if (acl_error) { (void)close_file(file); return system_failure(env, acl_error, "GetSecurityInfo/TokenUser"); }
  if (!admitted) { (void)close_file(file); return fail(env, "ERR_LEASE_ANCHOR", "Anchor ACL is outside the private qualification policy"); }
  OVERLAPPED position = { 0 };
  if (!LockFileEx(file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, MAXDWORD, MAXDWORD, &position)) {
    const DWORD error = GetLastError(); (void)close_file(file);
    if (error == ERROR_LOCK_VIOLATION) {
      napi_value missing;
      if (napi_get_undefined(env, &missing) != napi_ok) return api_failure(env);
      return missing;
    }
    return system_failure(env, error, "LockFileEx");
  }
#else
  if (napi_get_value_string_utf8(env, argument, NULL, 0, &length) != napi_ok) return api_failure(env);
  char *path = malloc(length + 1);
  if (!path) return fail(env, "ERR_LEASE_MEMORY", "Cannot allocate prototype anchor path");
  if (napi_get_value_string_utf8(env, argument, path, length + 1, &length) != napi_ok) {
    free(path); return api_failure(env);
  }
  if (!length || path[0] != '/' || strlen(path) != length) {
    free(path); return fail(env, "ERR_LEASE_PATH", "Anchor path must be absolute and contain no NUL");
  }
  /* No creation, unlink, rotation, background wait or Node-managed raw descriptor. */
  const native_file file = open(path, O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  const uint32_t open_error = (uint32_t)errno;
  free(path);
  if (file < 0) return system_failure(env, open_error, "open");
  struct stat identity;
  if (fstat(file, &identity) < 0) {
    const uint32_t error = (uint32_t)errno; (void)close_file(file); return system_failure(env, error, "fstat");
  }
  if (!S_ISREG(identity.st_mode) || identity.st_nlink != 1 || (identity.st_mode & 0077) != 0) {
    (void)close_file(file); return fail(env, "ERR_LEASE_ANCHOR", "Anchor must be a private single-link regular file");
  }
#if defined(__linux__)
  struct flock request = { 0 };
  request.l_type = F_WRLCK; request.l_whence = SEEK_SET;
  const int locked = fcntl(file, F_OFD_SETLK, &request);
  const char *operation = "fcntl";
#else
  const int locked = flock(file, LOCK_EX | LOCK_NB);
  const char *operation = "flock";
#endif
  if (locked < 0) {
    const uint32_t error = (uint32_t)errno; (void)close_file(file);
#if defined(__linux__)
    const bool not_acquired = error == EAGAIN || error == EACCES;
#else
    const bool not_acquired = error == EWOULDBLOCK;
#endif
    if (not_acquired) {
      napi_value missing;
      if (napi_get_undefined(env, &missing) != napi_ok) return api_failure(env);
      return missing; /* Not acquired, never proof of a live owner or semantic authority. */
    }
    return system_failure(env, error, operation);
  }
#endif
  lease *value = calloc(1, sizeof(*value));
  if (!value) { (void)close_file(file); return fail(env, "ERR_LEASE_MEMORY", "Cannot allocate prototype lease"); }
  value->context = context; value->file = file;
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_type_tag_object(env, result, &lease_tag) != napi_ok ||
      napi_wrap(env, result, value, finalize_lease, NULL, NULL) != napi_ok) {
    (void)close_once(value); free(value); return api_failure(env);
  }
  value->next = context->head;
  if (context->head) context->head->previous = value;
  context->head = value; context->references++;
  return result;
}
static napi_value release(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_valuetype type;
  void *data = NULL;
  bool tagged = false;
  if (napi_get_cb_info(env, info, &argc, &argument, NULL, &data) != napi_ok) return api_failure(env);
  if (argc != 1 || napi_typeof(env, argument, &type) != napi_ok || type != napi_object ||
      napi_check_object_type_tag(env, argument, &lease_tag, &tagged) != napi_ok || !tagged)
    return fail(env, "ERR_INVALID_LEASE", "Expected this prototype environment's opaque lease");
  lease *value = NULL;
  if (napi_unwrap(env, argument, (void **)&value) != napi_ok || !value || value->context != data)
    return fail(env, "ERR_INVALID_LEASE", "Foreign or invalid prototype lease");
  const bool first = !value->spent;
  const uint32_t error = close_once(value);
  if (error) return system_failure(env, error, CLOSE_OPERATION);
  napi_value result;
  if (napi_get_boolean(env, first, &result) != napi_ok) return api_failure(env);
  return result;
}
NAPI_MODULE_INIT() {
  owner *context = calloc(1, sizeof(*context));
  if (!context) return fail(env, "ERR_LEASE_MEMORY", "Cannot allocate prototype environment");
  if (napi_add_env_cleanup_hook(env, cleanup_environment, context) != napi_ok) {
    free(context); return api_failure(env);
  }
  napi_value method, kind;
  if (napi_create_function(env, "tryAcquire", NAPI_AUTO_LENGTH, try_acquire, context, &method) != napi_ok ||
      napi_set_named_property(env, exports, "tryAcquire", method) != napi_ok ||
      napi_create_function(env, "release", NAPI_AUTO_LENGTH, release, context, &method) != napi_ok ||
      napi_set_named_property(env, exports, "release", method) != napi_ok ||
      napi_create_string_utf8(env, LEASE_FIXTURE_KIND, NAPI_AUTO_LENGTH, &kind) != napi_ok ||
      napi_set_named_property(env, exports, "fixtureKind", kind) != napi_ok) return api_failure(env);
  return exports;
}
