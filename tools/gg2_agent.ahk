#Requires AutoHotkey v2.0
#SingleInstance Force
;==============================================================================
; gg2_agent.ahk - launch Gang Garrison 2 with the agent bridge enabled, and
; keep it running unattended.
;
; GM8 pops a modal show_message box when DirectSound cannot open an audio
; device, which happens routinely over RDP or on a headless session. That box
; blocks the whole game before the bridge ever starts listening, so this
; launcher stays resident and dismisses GM8 message boxes as they appear.
;
; Usage:
;   AutoHotkey64.exe gg2_agent.ahk <path to game exe> [extra game args]
;
; Exit codes: 0 = game ran and exited normally, 1 = could not start
;==============================================================================

; Everything here logs to a file beside the game as well as to stdout. Writing
; to stdout throws when the launcher is started detached (Start-Process gives it
; no console), and an uncaught throw pops a modal AutoHotkey dialog that hangs
; the launcher instead of reporting anything - which is exactly the failure this
; script exists to prevent.
logFile := ""

Log(msg) {
    global logFile
    try FileAppend(msg "`n", "*")
    if (logFile != "")
        try FileAppend(A_Now " " msg "`n", logFile)
}

Die(msg) {
    Log("FAIL: " msg)
    ExitApp 1
}

if (A_Args.Length < 1)
    Die("usage: gg2_agent.ahk <game exe> [extra args]")

exe := A_Args[1]
extra := ""
loop A_Args.Length - 1
    extra .= " " A_Args[A_Index + 1]

if !FileExist(exe)
    Die("not found: " exe)

SplitPath(exe, &exeName, &exeDir)
logFile := exeDir "\agent_launcher.log"
try FileDelete(logFile)

Log("launching " exeName " -agent" extra)

; Run throws rather than returning a failure code. The usual cause is a previous
; instance still exiting and holding the exe, so retry briefly before giving up.
pid := 0
lastErr := ""
loop 10 {
    try {
        Run('"' exe '" -agent' extra, exeDir, , &pid)
        break
    } catch as e {
        lastErr := e.Message
        Sleep 500
    }
}

if !pid
    Die("could not start the game: " lastErr)

Log("pid " pid)

dismissed := 0

; Stay resident for as long as the game lives, clearing modal boxes. The whole
; body is guarded: a window can always vanish between the check and the click.
loop {
    Sleep 250

    if !ProcessExist(pid)
        break

    try {
        ; GM8 message boxes: class TMessageForm, single OK button.
        h := WinExist("ahk_class TMessageForm ahk_pid " pid)
        if h {
            ControlClick("TButton1", h)
            dismissed++
            Log("dismissed a GM8 message box (" dismissed ")")
            Sleep 400
        }

        ; GM8 runtime error boxes use the standard dialog class.
        h := WinExist("ahk_class #32770 ahk_pid " pid)
        if h {
            title := ""
            try title := WinGetTitle(h)
            ControlClick("Button1", h)
            dismissed++
            Log("dismissed dialog '" title "' (" dismissed ")")
            Sleep 400
        }
    } catch as e {
        Log("warning while clearing dialogs: " e.Message)
        Sleep 400
    }
}

Log("game exited; dismissed " dismissed " dialog(s)")
ExitApp 0
