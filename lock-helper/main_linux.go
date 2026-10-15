// The inherited descriptor shares its open file description with Node. Do not
// unlock it on success: Node retains the lock until it closes its descriptor.
package main

import (
	"flag"
	"fmt"
	"os"
	"syscall"
	"time"
)

func run() int {
	mode := flag.String("mode", "", "shared or exclusive")
	fd := flag.Int("fd", 3, "inherited regular-file descriptor")
	timeout := flag.Int64("timeout-ms", 300000, "lock wait timeout in milliseconds")
	parent := flag.Int("parent-pid", 0, "expected parent PID")
	flag.Parse()
	if flag.NArg() != 0 || (*mode != "shared" && *mode != "exclusive") || *fd < 3 || *timeout < 0 || *timeout > 300000 || *parent < 1 {
		fmt.Fprintln(os.Stderr, "invalid lock request")
		return 2
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(*fd, &stat); err != nil || stat.Mode&syscall.S_IFMT != syscall.S_IFREG {
		fmt.Fprintln(os.Stderr, "lock descriptor must be a regular file")
		return 2
	}
	op := syscall.LOCK_EX
	if *mode == "shared" {
		op = syscall.LOCK_SH
	}
	deadline := time.Now().Add(time.Duration(*timeout) * time.Millisecond)
	for {
		// Stop an orphaned waiter instead of retaining a descriptor until timeout.
		if os.Getppid() != *parent {
			return 76
		}
		err := syscall.Flock(*fd, op|syscall.LOCK_NB)
		if err == nil {
			return 0
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN && err != syscall.EINTR {
			fmt.Fprintln(os.Stderr, "cannot acquire lock:", err)
			return 1
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return 75
		}
		if remaining > 20*time.Millisecond {
			remaining = 20 * time.Millisecond
		}
		time.Sleep(remaining)
	}
}

func main() {
	os.Exit(run())
}
