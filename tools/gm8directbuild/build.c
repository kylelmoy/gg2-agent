// build.c - the payload injected into a running Game_Maker.exe (8.0.0.0,
// sha256 f3db12d340afb849efce8d0ae2cac941e10971a13227db763d3537f8d1814109) to
// make it build a project without ever showing File > Create Executable's
// Save dialog.
//
// Game Maker 8 is Delphi (VCL), and Delphi keeps its published-method RTTI in
// the compiled binary even in a release build. The Create Executable menu
// item's DFM resource names its OnClick handler "Createstandalone1Click",
// which is enough to find the compiled method address directly - no signature
// scanning needed, and no fragility to worry about since this only ever has
// to work against this one exact executable (see gm8directbuild.js for the
// sha256 guard).
//
// Traced with Ghidra (see the repo history for the session that did this):
//   Createstandalone1Click(void)                    - the menu's OnClick;
//     checks the project has >=1 room, then calls -->
//   FUN_005d47bc(filename: AnsiString)               - shows the Save dialog,
//     reads back its chosen filename, then calls    -->
//   FUN_005d453c(filename, 0, 0)                     - shows "Saving
//     Executable..." on the status bar, then calls  -->
//   FUN_005d418c(filename, 0, 0)                     - the actual build: loads
//     "rundata" (the runner stub template) into a stream, validates its size,
//     patches in the project's icon, conditionally appends "dxdata" (D3D8
//     support), writes random filler, and saves the stream to `filename`.
//
// This DLL calls straight into FUN_005d453c (0x005d453c), skipping both the
// room-count guard and the Save dialog entirely - so it needs a project with
// at least one room already open in the IDE, and it needs a filename supplied
// by the caller (there is no dialog left to read one back from).
//
// The call uses Delphi's `register` convention: the first three arguments go
// in EAX, EDX, ECX rather than on the stack. MSVC has no calling-convention
// attribute for this (unlike GCC's regparm(3), which is the same order but
// isn't available for a 32-bit MSVC build), so it is written by hand in
// inline asm.
//
// Delphi's AnsiString is a plain pointer to the first character, with a
// hidden 8-byte header immediately before it: a 4-byte refcount and a 4-byte
// length. A refcount of -1 marks a "constant" string the runtime will never
// try to free or copy-on-write - exactly what a short-lived, hand-built
// string needs here.
//
// Rebuilding (needs the Visual Studio Build Tools x86 toolset):
//   "%ProgramFiles(x86)%\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars32.bat"
//   cl /LD /MT build.c /Fe:build.dll /link /DEF:build.def /SUBSYSTEM:WINDOWS

#include <windows.h>
#include <string.h>
#include <stdlib.h>
#pragma comment(lib, "user32.lib")

// The address of FUN_005d453c in Game_Maker.exe 8.0.0.0. Only valid for the
// exact build gm8directbuild.js checks the hash of before ever loading this
// DLL - if Game Maker is ever replaced by a differently-built exe (even a
// same-version recompile), this address means something else entirely.
#define BUILD_ENTRY_POINT 0x005d453c

typedef struct {
    char outputPath[260];
    char logPath[260];
} BuildParams;

static void WriteLogStart(const char *path, const char *msg) {
    HANDLE h = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD written;
        WriteFile(h, msg, (DWORD)strlen(msg), &written, NULL);
        CloseHandle(h);
    }
}

static void AppendLog(const char *path, const char *msg) {
    HANDLE h = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        SetFilePointer(h, 0, NULL, FILE_END);
        DWORD written;
        WriteFile(h, msg, (DWORD)strlen(msg), &written, NULL);
        CloseHandle(h);
    }
}

__declspec(dllexport) DWORD WINAPI DoBuild(LPVOID lpParam) {
    BuildParams *p = (BuildParams *)lpParam;
    char buf[600];

    WriteLogStart(p->logPath, "DoBuild entered.\n");

    __try {
        size_t len = strlen(p->outputPath);
        /* Delphi short-lived AnsiString: [-8 refcount=-1][-4 length][data...][nul] */
        unsigned char *block = (unsigned char *)malloc(len + 9);
        if (!block) {
            AppendLog(p->logPath, "ERROR: malloc failed\n");
            return 1;
        }
        *(long *)(block) = -1;
        *(long *)(block + 4) = (long)len;
        memcpy(block + 8, p->outputPath, len);
        block[8 + len] = 0;
        void *strPtr = block + 8;

        wsprintfA(buf, "About to call FUN_005d453c path=%s strPtr=%p\n", p->outputPath, strPtr);
        AppendLog(p->logPath, buf);

        __try {
            __asm {
                mov eax, strPtr
                xor edx, edx
                xor ecx, ecx
                mov ebx, BUILD_ENTRY_POINT
                call ebx
            }
            AppendLog(p->logPath, "Call returned normally.\n");
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            wsprintfA(buf, "SEH exception during call: 0x%08X\n", GetExceptionCode());
            AppendLog(p->logPath, buf);
        }

        DWORD attrs = GetFileAttributesA(p->outputPath);
        if (attrs != INVALID_FILE_ATTRIBUTES) {
            HANDLE hf = CreateFileA(p->outputPath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
            DWORD size = 0;
            if (hf != INVALID_HANDLE_VALUE) {
                size = GetFileSize(hf, NULL);
                CloseHandle(hf);
            }
            wsprintfA(buf, "Output file exists, size=%lu\n", size);
            AppendLog(p->logPath, buf);
        } else {
            AppendLog(p->logPath, "Output file does NOT exist after call.\n");
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        wsprintfA(buf, "OUTER SEH exception: 0x%08X\n", GetExceptionCode());
        AppendLog(p->logPath, buf);
    }

    AppendLog(p->logPath, "DoBuild finished.\n");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved) {
    (void)hinst; (void)reason; (void)reserved;
    return TRUE;
}
