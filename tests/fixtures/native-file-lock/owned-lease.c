/*
 * Linux/Darwin qualification fixture for environment-owned kernel leases.
 * Zones: native resource lifetime, disposable validation
 * Not a production backend, stable API, migration or recovery implementation.
 * Linux build: cc -std=c11 -shared -fPIC -I <public-node-include> owned-lease.c -o owned-lease.node
 * Darwin build: use -bundle -undefined dynamic_lookup instead of -shared.
 */
#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#if defined(__linux__)
#define LEASE_FIXTURE_KIND "linux-owned-lease-prototype-v1"
#elif defined(__APPLE__) && defined(__MACH__)
#define LEASE_FIXTURE_KIND "darwin-owned-lease-prototype-v1"
#include <sys/file.h>
#else
#error "This ownership prototype supports Linux and Darwin only"
#endif
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct owner owner;
typedef struct lease lease;
struct owner { lease *head; size_t references; bool closing; };
struct lease { owner *context; lease *previous, *next; int fd; bool spent; };
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
static napi_value system_failure(napi_env env, int number, const char *operation) {
  napi_value message, error, value;
  char text[256];
  snprintf(text, sizeof(text), "Owned-lease %s failed: %s", operation, strerror(number));
  if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(env, NULL, message, &error) != napi_ok ||
      napi_create_int32(env, number, &value) != napi_ok ||
      napi_set_named_property(env, error, "errno", value) != napi_ok ||
      napi_create_string_utf8(env, operation, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, error, "syscall", value) != napi_ok) return api_failure(env);
  napi_throw(env, error);
  return NULL;
}
/* Spend before close: an error need not preserve descriptor ownership, so retrying
 * the number could close a successor. Error retirement remains unqualified; no retry. */
static int close_once(lease *value) {
  if (value->spent) return 0;
  const int fd = value->fd;
  value->spent = true; value->fd = -1;
  return close(fd) == 0 ? 0 : errno;
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
  const int fd = open(path, O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  const int open_error = errno;
  free(path);
  if (fd < 0) return system_failure(env, open_error, "open");
  struct stat identity;
  if (fstat(fd, &identity) < 0) {
    const int error = errno; (void)close(fd); return system_failure(env, error, "fstat");
  }
  if (!S_ISREG(identity.st_mode) || identity.st_nlink != 1 || (identity.st_mode & 0077) != 0) {
    (void)close(fd); return fail(env, "ERR_LEASE_ANCHOR", "Anchor must be a private single-link regular file");
  }
#if defined(__linux__)
  struct flock request = { 0 };
  request.l_type = F_WRLCK; request.l_whence = SEEK_SET;
  const int locked = fcntl(fd, F_OFD_SETLK, &request);
  const char *operation = "fcntl";
#else
  const int locked = flock(fd, LOCK_EX | LOCK_NB);
  const char *operation = "flock";
#endif
  if (locked < 0) {
    const int error = errno; (void)close(fd);
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
  lease *value = calloc(1, sizeof(*value));
  if (!value) { (void)close(fd); return fail(env, "ERR_LEASE_MEMORY", "Cannot allocate prototype lease"); }
  value->context = context; value->fd = fd;
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
  const int error = close_once(value);
  if (error) return system_failure(env, error, "close");
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
