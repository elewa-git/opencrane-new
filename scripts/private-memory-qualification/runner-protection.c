// Use Node's C API to measure the runner itself, never a probe child.
#include <node_api.h>
#include <stdbool.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>

static uid_t real_uid, effective_uid;
static gid_t real_gid, effective_gid;

static napi_value boolean_result(napi_env env, bool value) {
    napi_value result;
    if (napi_get_boolean(env, value, &result) != napi_ok) {
        return NULL;
    }
    return result;
}

static napi_value failure_result(napi_env env, const char *failure) {
    napi_value result;
    if (napi_create_string_utf8(env, failure, NAPI_AUTO_LENGTH, &result) != napi_ok) {
        return NULL;
    }
    return result;
}

static napi_value protect(napi_env env, napi_callback_info info) {
    (void)info;
    if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) {
        return failure_result(env, "dumpability_protection_failed");
    }
    return boolean_result(env, true);
}

static napi_value check(napi_env env, napi_callback_info info) {
    (void)info;
    struct rlimit limits;
    if (getrlimit(RLIMIT_CORE, &limits) != 0) {
        return failure_result(env, "core_limit_measurement_failed");
    }
    if (limits.rlim_cur != 0 || limits.rlim_max != 0) {
        return failure_result(env, "core_limit_not_zero");
    }
    int dumpable = prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L);
    if (dumpable < 0) {
        return failure_result(env, "dumpability_measurement_failed");
    }
    if (dumpable != 0) {
        return failure_result(env, "process_dumpable");
    }
    if (getuid() != real_uid || geteuid() != effective_uid ||
        getgid() != real_gid || getegid() != effective_gid) {
        return failure_result(env, "process_identity_changed");
    }
    return boolean_result(env, true);
}

static napi_value initialise(napi_env env, napi_value exports) {
    real_uid = getuid();
    effective_uid = geteuid();
    real_gid = getgid();
    effective_gid = getegid();
    napi_value protect_function;
    napi_value check_function;
    if (napi_create_function(env, "protect", NAPI_AUTO_LENGTH, protect, NULL,
                             &protect_function) != napi_ok ||
        napi_create_function(env, "check", NAPI_AUTO_LENGTH, check, NULL,
                             &check_function) != napi_ok ||
        napi_set_named_property(env, exports, "protect", protect_function) != napi_ok ||
        napi_set_named_property(env, exports, "check", check_function) != napi_ok) {
        return NULL;
    }
    return exports;
}

NAPI_MODULE(runner_protection, initialise)
