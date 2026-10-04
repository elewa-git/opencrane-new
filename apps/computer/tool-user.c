// The supervisor starts this once per executor connection, never setuid.
// No sockets can be created by the executor or any of its descendants.
#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <grp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#define DENY(n) BPF_JUMP(BPF_JMP+BPF_JEQ+BPF_K, n, 0, 1), BPF_STMT(BPF_RET+BPF_K, SECCOMP_RET_ERRNO | EPERM)
int main(int argc, char **argv) {
  const int host = argc == 2 && strcmp(argv[1], "host") == 0;
  if (argc != 1 && !host) return 1;
  if (setgroups(0, NULL) || setgid(1001) || setuid(1001)) { perror("drop user"); return 1; }
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD+BPF_W+BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP+BPF_JEQ+BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET+BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD+BPF_W+BPF_ABS, offsetof(struct seccomp_data, nr)),
    // Refuse the x32 ABI as well as alternate architectures.
    BPF_JUMP(BPF_JMP+BPF_JGE+BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET+BPF_K, SECCOMP_RET_KILL_PROCESS),
    DENY(__NR_socket), DENY(__NR_connect), DENY(__NR_io_uring_setup),
    DENY(__NR_ptrace), DENY(__NR_process_vm_readv), DENY(__NR_process_vm_writev),
    DENY(__NR_pidfd_getfd),
    BPF_STMT(BPF_RET+BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = {sizeof(rules) / sizeof(rules[0]), rules};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) { perror("seccomp"); return 1; }
  clearenv();
  setenv("HOME", "/home/tool", 1); setenv("CODEX_HOME", "/home/tool/.codex", 1);
  setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1); setenv("SHELL", "/bin/bash", 1);
  if (chdir("/workspace")) { perror("chdir"); return 1; }
  if (host) {
    execl("/usr/local/libexec/codex-code-mode-host", "codex-code-mode-host", NULL);
    perror("exec host"); return 1;
  }
  execl("/usr/local/bin/codex", "codex", "exec-server", "--listen", "stdio://", NULL);
  perror("exec-server"); return 1;
}
