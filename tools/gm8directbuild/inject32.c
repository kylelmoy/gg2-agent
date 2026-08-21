// inject32.c - load build.dll into a running process and call its exported
// DoBuild with a target output path, then return.
//
// Deliberately built as a 32-bit console exe: Game_Maker.exe is a 32-bit
// process, and CreateRemoteThread/VirtualAllocEx/WriteProcessMemory into a
// 32-bit target do not work from a 64-bit caller (confirmed: a 64-bit
// PowerShell host gets back a truncated, wrong address; the WOW64 boundary
// does not let a 64-bit process hand a 32-bit one a same-sized pointer). This
// is why gm8directbuild.js (which runs under whatever Node happens to be
// installed - x64 in practice) shells out to this small standalone helper
// rather than doing the injection itself.
//
// Standard two-step remote-thread injection:
//   1. write the DLL's path into the target process, CreateRemoteThread on
//      kernel32!LoadLibraryA to load it there - LoadLibraryA's own return
//      value (the thread's exit code) is the module's base address *in the
//      target process*.
//   2. load the same DLL locally (never calling anything in it - only to
//      read DoBuild's address), subtract the local module base to get its
//      RVA, then add that RVA to the remote module base from step 1 to get
//      DoBuild's real address inside the target. This works because both
//      copies of the same DLL file have identical internal layout; only the
//      base address differs between the two processes.
//   3. write a BuildParams struct (see build.c) into the target and
//      CreateRemoteThread straight to that computed address.
//
// Usage: inject32.exe <pid> <dllPath> <outputExePath> <logPath>
// Exit codes: 0 = the remote thread ran to completion (this does not by
// itself mean the build succeeded - check outputPath and the log). Non-zero
// = a Win32-level failure before or during injection, printed to stderr.

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    char outputPath[260];
    char logPath[260];
} BuildParams;

static void fail(const char *what) {
    fprintf(stderr, "%s failed: GetLastError=%lu\n", what, GetLastError());
    exit(1);
}

static void pad260(char *dst, const char *src) {
    ZeroMemory(dst, 260);
    strncpy(dst, src, 259);
}

int main(int argc, char **argv) {
    if (argc != 5) {
        fprintf(stderr, "usage: inject32.exe <pid> <dllPath> <outputExePath> <logPath>\n");
        return 2;
    }
    DWORD pid = (DWORD)strtoul(argv[1], NULL, 10);
    const char *dllPath = argv[2];
    const char *outputPath = argv[3];
    const char *logPath = argv[4];

    HANDLE hProc = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid);
    if (!hProc) fail("OpenProcess");
    printf("opened process %lu\n", pid);

    // --- step 1: LoadLibraryA the DLL into the target process ---------------
    size_t dllPathLen = strlen(dllPath) + 1;
    LPVOID remoteDllPath = VirtualAllocEx(hProc, NULL, dllPathLen, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remoteDllPath) fail("VirtualAllocEx (dll path)");
    if (!WriteProcessMemory(hProc, remoteDllPath, dllPath, dllPathLen, NULL)) fail("WriteProcessMemory (dll path)");

    LPTHREAD_START_ROUTINE loadLibraryAddr = (LPTHREAD_START_ROUTINE)GetProcAddress(GetModuleHandleA("kernel32.dll"), "LoadLibraryA");
    HANDLE hThread1 = CreateRemoteThread(hProc, NULL, 0, loadLibraryAddr, remoteDllPath, 0, NULL);
    if (!hThread1) fail("CreateRemoteThread (LoadLibraryA)");
    WaitForSingleObject(hThread1, 10000);
    DWORD remoteModuleBase = 0;
    GetExitCodeThread(hThread1, &remoteModuleBase);
    CloseHandle(hThread1);
    VirtualFreeEx(hProc, remoteDllPath, 0, MEM_RELEASE);
    if (remoteModuleBase == 0) {
        fprintf(stderr, "LoadLibraryA returned NULL in the target process - the DLL failed to load there\n");
        return 1;
    }
    printf("loaded, remote module base = 0x%08lX\n", remoteModuleBase);

    // --- step 2: compute DoBuild's address by RVA, not by loading it here ---
    HMODULE hLocal = LoadLibraryA(dllPath);
    if (!hLocal) fail("LoadLibraryA (local, for RVA only)");
    FARPROC localDoBuild = GetProcAddress(hLocal, "DoBuild");
    if (!localDoBuild) fail("GetProcAddress(DoBuild) locally");
    ptrdiff_t rva = (BYTE *)localDoBuild - (BYTE *)hLocal;
    FreeLibrary(hLocal);
    if (rva <= 0 || rva > 0x100000) {
        fprintf(stderr, "DoBuild RVA looks wrong (0x%tX) - refusing to touch the target process\n", rva);
        return 1;
    }
    LPTHREAD_START_ROUTINE remoteDoBuild = (LPTHREAD_START_ROUTINE)(remoteModuleBase + rva);
    printf("DoBuild RVA = 0x%tX, remote address = %p\n", rva, (void *)remoteDoBuild);

    // --- step 3: write BuildParams and call it ------------------------------
    BuildParams params;
    pad260(params.outputPath, outputPath);
    pad260(params.logPath, logPath);

    LPVOID remoteParams = VirtualAllocEx(hProc, NULL, sizeof(params), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remoteParams) fail("VirtualAllocEx (params)");
    if (!WriteProcessMemory(hProc, remoteParams, &params, sizeof(params), NULL)) fail("WriteProcessMemory (params)");

    HANDLE hThread2 = CreateRemoteThread(hProc, NULL, 0, remoteDoBuild, remoteParams, 0, NULL);
    if (!hThread2) fail("CreateRemoteThread (DoBuild)");
    printf("DoBuild thread started, waiting...\n");
    DWORD waitResult = WaitForSingleObject(hThread2, 30000);
    DWORD exitCode = 0;
    GetExitCodeThread(hThread2, &exitCode);
    CloseHandle(hThread2);
    VirtualFreeEx(hProc, remoteParams, 0, MEM_RELEASE);
    CloseHandle(hProc);

    if (waitResult == WAIT_TIMEOUT) {
        fprintf(stderr, "DoBuild did not return within 30s\n");
        return 1;
    }
    printf("DoBuild thread exit code = %lu\n", exitCode);
    return 0;
}
