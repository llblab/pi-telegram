/*
 * Public N-API compile/load smoke fixture; owns no locks or native resources.
 * Zones: native build qualification, disposable validation
 * Loading this fixture is not ownership, teardown, permissions or recovery evidence.
 */
#include <node_api.h>

NAPI_MODULE_INIT() {
  const napi_type_tag tag = { 0x4e6170694275696cULL, 0x6450726f62655631ULL };
  napi_value kind, version, compiled;
  uint32_t host = 0;
  bool tagged = false;
  if (napi_get_version(env, &host) != napi_ok || host < 8 ||
      napi_type_tag_object(env, exports, &tag) != napi_ok ||
      napi_check_object_type_tag(env, exports, &tag, &tagged) != napi_ok || !tagged ||
      napi_create_string_utf8(env, "public-napi-build-probe-v1", NAPI_AUTO_LENGTH, &kind) != napi_ok ||
      napi_set_named_property(env, exports, "fixtureKind", kind) != napi_ok ||
      napi_create_uint32(env, host, &version) != napi_ok ||
      napi_set_named_property(env, exports, "hostNapi", version) != napi_ok ||
      napi_create_uint32(env, NAPI_VERSION, &compiled) != napi_ok ||
      napi_set_named_property(env, exports, "compiledNapi", compiled) != napi_ok) {
    napi_throw_error(env, "ERR_NAPI_BUILD_PROBE", "Public N-API build/load probe failed");
    return NULL;
  }
  return exports;
}
