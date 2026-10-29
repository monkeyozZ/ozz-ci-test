// Compiled with CGO_ENABLED=0 GOOS=linux GOARCH=arm64 for an isolated fixture
// image. Do not run the resource modes on the host. The product-registered
// Builder supplies the cgroup and fixed ext4 filesystem before RUN starts.
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

func record(event string, facts map[string]any) {
	if facts == nil {
		facts = map[string]any{}
	}
	facts["event"] = event
	facts["at"] = time.Now().UTC().Format(time.RFC3339Nano)
	value, err := json.Marshal(facts)
	if err != nil {
		os.Exit(96)
	}
	fmt.Println("S6_FAULT " + string(value))
}

func credentialCheck(required bool) {
	guarded := []string{"/etc/ozz-builder", "/var/lib/ozz-builder/manager", "/run/ozz-builder-credentials", "/run/docker.sock", "/var/run/docker.sock"}
	for _, path := range guarded {
		if syscall.Access(path, 4) == nil {
			record("guarded-path-readable", map[string]any{"path": path})
			os.Exit(94)
		}
	}
	value, err := os.ReadFile("/run/secrets/probe")
	if !required {
		if err == nil || !os.IsNotExist(err) {
			record("unexpected-secret-mount", nil)
			os.Exit(94)
		}
		record("credential-paths-inaccessible", nil)
		return
	}
	if err != nil || len(value) < 32 || len(value) > 128 {
		record("explicit-secret-missing", nil)
		os.Exit(94)
	}
	for _, item := range os.Environ() {
		if bytes.Contains([]byte(item), value) {
			record("secret-in-environment", nil)
			os.Exit(94)
		}
	}
	digest := sha256.Sum256(value)
	record("explicit-secret-mounted", map[string]any{"sha256": hex.EncodeToString(digest[:]), "environmentContainsValue": false})
	// This is a generated canary with no external authority. The manager must
	// redact it even when it spans writes. The observer never stores raw logs
	// before checking for canary leakage.
	fmt.Print("S6_CANARY ")
	os.Stdout.Write(value[:len(value)/2])
	time.Sleep(100 * time.Millisecond)
	os.Stdout.Write(value[len(value)/2:])
	fmt.Println()
	clear(value)
}

func hold() {
	for i := 0; i < 12; i++ {
		time.Sleep(10 * time.Second)
		record("hold-heartbeat", map[string]any{"sequence": i})
	}
	record("self-bound-reached", nil)
	os.Exit(93)
}

func networkCheck() {
	results := []map[string]any{}
	for _, address := range []string{"10.203.0.1:22", "192.168.5.2:51446", "192.168.5.2:51445", "169.254.169.254:80"} {
		connection, err := net.DialTimeout("tcp4", address, 750*time.Millisecond)
		if err == nil {
			connection.Close()
		}
		results = append(results, map[string]any{"address": address, "connectionBlocked": err != nil})
		if err == nil {
			record("direct-network-escape", map[string]any{"address": address})
			os.Exit(94)
		}
	}
	connection, err := net.DialTimeout("tcp4", "192.168.5.2:51449", 2*time.Second)
	if err != nil {
		record("approved-proxy-unreachable", nil)
		os.Exit(94)
	}
	defer connection.Close()
	connection.SetDeadline(time.Now().Add(2 * time.Second))
	fmt.Fprint(connection, "CONNECT host.lima.internal:51446 HTTP/1.1\r\nHost: host.lima.internal:51446\r\n\r\n")
	status, err := bufio.NewReader(io.LimitReader(connection, 4096)).ReadString('\n')
	denied := err == nil && strings.HasPrefix(status, "HTTP/1.1 403 ")
	record("network-boundaries", map[string]any{"directConnections": results, "approvedProxyReached": true, "privateConnectDenied": denied})
	if !denied {
		os.Exit(94)
	}
}

func cpu() {
	runtime.GOMAXPROCS(4)
	record("cpu-start", nil)
	deadline := time.Now().Add(8 * time.Second)
	var workers sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		workers.Add(1)
		go func(seed uint64) {
			defer workers.Done()
			value := seed + 1
			for time.Now().Before(deadline) {
				for i := 0; i < 100000; i++ {
					value = value*6364136223846793005 + 1
				}
			}
			runtime.KeepAlive(value)
		}(uint64(worker))
	}
	workers.Wait()
	record("cpu-complete", nil)
}

func pids() {
	runtime.GOMAXPROCS(1)
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		os.Exit(96)
	}
	defer null.Close()
	children := []*exec.Cmd{}
	defer func() {
		for _, child := range children {
			child.Process.Kill()
			child.Wait()
		}
	}()
	limited := false
	for i := 0; i < 256; i++ {
		child := exec.Command("/s6-workload", "child")
		child.Stdout, child.Stderr = null, null
		if err := child.Start(); err != nil {
			limited = errors.Is(err, syscall.EAGAIN)
			break
		}
		children = append(children, child)
	}
	record("pid-allocation-ended", map[string]any{"childrenStarted": len(children), "parentSawEagain": limited})
	time.Sleep(8 * time.Second)
}

func disk() {
	file, err := os.OpenFile("/s6-quota-fill", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		record("disk-open-failed", nil)
		os.Exit(96)
	}
	block := make([]byte, 1024*1024)
	var total int64
	for total < 2*1024*1024*1024 {
		n, failure := file.Write(block)
		total += int64(n)
		if failure != nil {
			err = failure
			break
		}
	}
	if err == nil {
		err = file.Sync()
	}
	file.Close()
	record("disk-allocation-ended", map[string]any{"bytes": total, "enospc": errors.Is(err, syscall.ENOSPC)})
	time.Sleep(5 * time.Second)
}

func memory() {
	chunks := [][]byte{}
	for index := 0; index < 512; index++ {
		chunk := make([]byte, 4*1024*1024)
		for page := 0; page < len(chunk); page += 4096 {
			chunk[page] = 1
		}
		chunks = append(chunks, chunk)
		if index%32 == 0 {
			record("memory-touched", map[string]any{"bytes": (index + 1) * len(chunk)})
		}
	}
	runtime.KeepAlive(chunks)
	record("memory-bound-without-oom", nil)
	time.Sleep(5 * time.Second)
}

func serve() {
	marker, err := os.ReadFile("/s6-marker")
	if err != nil || len(marker) > 512 {
		os.Exit(96)
	}
	server := &http.Server{
		Addr: ":8080", ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 10 * time.Second,
		Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/" || request.Method != http.MethodGet {
				http.NotFound(writer, request)
				return
			}
			writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
			writer.Write(marker)
		}),
	}
	if server.ListenAndServe() != nil {
		os.Exit(96)
	}
}

func main() {
	if runtime.GOOS != "linux" || runtime.GOARCH != "arm64" || len(os.Args) != 2 {
		os.Exit(96)
	}
	mode := os.Args[1]
	if mode == "serve" {
		serve()
		return
	}
	if mode == "child" {
		time.Sleep(45 * time.Second)
		return
	}
	if mode != "cancel" && mode != "timeout" && mode != "disconnect" && mode != "pids" && mode != "disk" && mode != "memory" && mode != "artifact" {
		os.Exit(96)
	}
	time.AfterFunc(150*time.Second, func() { os.Exit(93) })
	credentialCheck(mode == "cancel")
	if mode == "cancel" {
		networkCheck()
	}
	record("ready", map[string]any{"case": mode, "pid": os.Getpid(), "uid": os.Getuid()})
	// Gives the independent kernel observer time to capture baseline counters.
	time.Sleep(12 * time.Second)
	switch mode {
	case "cancel":
		cpu()
		hold()
	case "timeout", "disconnect":
		hold()
	case "pids":
		pids()
	case "disk":
		disk()
	case "memory":
		memory()
	case "artifact":
		record("artifact-produced", nil)
		return
	}
	os.Exit(92)
}
