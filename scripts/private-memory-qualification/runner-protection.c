#define _GNU_SOURCE
// Use Node's C API to measure the runner itself, never a probe child.
#include <node_api.h>
#include <stdbool.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>
#include <string.h>

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

static napi_value null_result(napi_env env) {
    napi_value result;
    if (napi_get_null(env, &result) != napi_ok) {
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

// Read a live service reply through a local socket and return the kernel's peer PID.
static napi_value probe(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value args[2];
    char role[32], challenge[64];
    size_t role_length = 0, challenge_length = 0;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2 ||
        napi_get_value_string_utf8(env, args[0], role, sizeof(role), &role_length) != napi_ok ||
        napi_get_value_string_utf8(env, args[1], challenge, sizeof(challenge),
                                   &challenge_length) != napi_ok) {
        return null_result(env);
    }
    if ((strcmp(role, "serverDelivery") != 0 && strcmp(role, "bridge") != 0) ||
        challenge_length != 36 || strspn(challenge, "0123456789abcdef-") != 36) {
        return null_result(env);
    }
    int connection = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (connection < 0) {
        return null_result(env);
    }
    struct timeval timeout = { .tv_sec = 2, .tv_usec = 0 };
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    address.sun_path[0] = '\0';
    const char *prefix = "opencrane-private-";
    size_t prefix_length = strlen(prefix);
    memcpy(address.sun_path + 1, prefix, prefix_length);
    memcpy(address.sun_path + 1 + prefix_length, role, role_length);
    socklen_t address_length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) +
                                          1 + prefix_length + role_length);
    struct ucred peer;
    socklen_t peer_length = sizeof(peer);
    char request[65], reply[128];
    memcpy(request, challenge, challenge_length);
    request[challenge_length] = '\n';
    bool success = true;
    if (setsockopt(connection, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0) {
        success = false;
    }
    if (success && setsockopt(connection, SOL_SOCKET, SO_SNDTIMEO,
                              &timeout, sizeof(timeout)) != 0) {
        success = false;
    }
    if (success && connect(connection, (struct sockaddr *)&address, address_length) != 0) {
        success = false;
    }
    if (success && getsockopt(connection, SOL_SOCKET, SO_PEERCRED,
                              &peer, &peer_length) != 0) {
        success = false;
    }
    if (success && peer_length != sizeof(peer)) {
        success = false;
    }
    if (success && send(connection, request, challenge_length + 1, MSG_NOSIGNAL) !=
                   (ssize_t)(challenge_length + 1)) {
        success = false;
    }
    size_t received = 0;
    while (success && received < sizeof(reply) - 1) {
        ssize_t next = recv(connection, reply + received, sizeof(reply) - 1 - received, 0);
        if (next <= 0) {
            success = false;
            break;
        }
        received += (size_t)next;
        if (reply[received - 1] == '\n') {
            break;
        }
    }
    close(connection);
    if (!success || received == 0 || reply[received - 1] != '\n') {
        return null_result(env);
    }
    reply[received] = '\0';
    napi_value result, pid_value, reply_value;
    if (napi_create_object(env, &result) != napi_ok ||
        napi_create_int32(env, peer.pid, &pid_value) != napi_ok ||
        napi_create_string_utf8(env, reply, (size_t)received, &reply_value) != napi_ok ||
        napi_set_named_property(env, result, "pid", pid_value) != napi_ok ||
        napi_set_named_property(env, result, "reply", reply_value) != napi_ok) {
        return NULL;
    }
    return result;
}

static napi_value initialise(napi_env env, napi_value exports) {
    real_uid = getuid();
    effective_uid = geteuid();
    real_gid = getgid();
    effective_gid = getegid();
    napi_value protect_function;
    napi_value check_function;
    napi_value probe_function;
    if (napi_create_function(env, "protect", NAPI_AUTO_LENGTH, protect, NULL,
                             &protect_function) != napi_ok ||
        napi_create_function(env, "check", NAPI_AUTO_LENGTH, check, NULL,
                             &check_function) != napi_ok ||
        napi_create_function(env, "probe", NAPI_AUTO_LENGTH, probe, NULL,
                             &probe_function) != napi_ok ||
        napi_set_named_property(env, exports, "protect", protect_function) != napi_ok ||
        napi_set_named_property(env, exports, "check", check_function) != napi_ok) {
        return NULL;
    }
    if (napi_set_named_property(env, exports, "probe", probe_function) != napi_ok) {
        return NULL;
    }
    return exports;
}

NAPI_MODULE(runner_protection, initialise)
