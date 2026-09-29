// void agentAudioStopSong()
// Replaces the first line of Scripts/AudioControl/AudioControlPlaySong.gml,
// which is `if(AudioControl.currentSong != -1) sound_stop(...)` - a braceless
// `if` whose body is on the same line, so it is one line for one line.
//
// WHY. WinBanner's Create reaches AudioControlPlaySong unguarded, and on some
// runs AudioControl has no currentSong at all, so every round end raises
// "Unknown variable currentSong" as a modal dialog. The launcher dismisses it,
// but one dialog per round still stalls the game while it waits, which is enough
// for a sped-up client (gg2_speed) to fall behind its server and be dropped. Why
// the variable goes missing is not established - docs/CLIENTDEBUG.md has what
// was ruled out.
//
// This does not fix the game's bug and must not: it makes the stock script safe
// to call, then does exactly what the stock line did.

global.agentAudioOk = false;

if (!instance_exists(AudioControl))
    exit;

with (AudioControl)
    global.agentAudioOk = variable_local_exists("currentSong");

if (!global.agentAudioOk)
{
    // The rest of the stock script reads and writes these unconditionally.
    with (AudioControl)
    {
        currentSong = -1;
        currentSongLoop = false;
        currentSongPlayed = true;
    }

    exit;
}

// The stock line.
if (AudioControl.currentSong != -1)
    sound_stop(AudioControl.currentSong);
