#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void) {
    char canary[256];
    char command[16];
    if (fgets(canary, sizeof(canary), stdin) == NULL) return 2;
    long page_size = sysconf(_SC_PAGESIZE);
    if (page_size <= 0) return 3;
    volatile unsigned char *page = mmap(NULL, (size_t)page_size, PROT_NONE,
                                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (page == MAP_FAILED) return 4;
    puts("ready");
    fflush(stdout);
    if (fgets(command, sizeof(command), stdin) == NULL) return 5;
    // Keep the input in memory and fault on a page with no access permission.
    *page = (unsigned char)canary[0];
    return 6;
}
