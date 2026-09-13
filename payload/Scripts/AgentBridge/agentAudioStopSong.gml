// void agentAudioStopSong()
// Replaces the first line of Scripts/AudioControl/AudioControlPlaySong.gml,
// which is `if(AudioControl.currentSong != -1) sound_stop(...)` - a braceless
// `if` whose body is on the same line, so it is one line for one line.
//
// WHY. AudioControl's Create reads
//
//     if(instance_number(AudioControl)) > 1 {
//
// with the parenthesis in the wrong place: the test is `instance_number(...)`,
// which is truthy for the instance running it, so the guard fires for the FIRST
// AudioControl rather than a second one and it destroys itself before
// `currentSong = -1` below ever takes effect. Every later AudioControl.currentSong
// read then raises "Unknown variable currentSong".
//
// Nothing in the game notices until a round ends, because WinBanner's Create is
// the call site that reaches this script - and it is the LAST statement there,
// so GM8's Ignore abandons only the victory sound. The cost is not the lost
// sound, it is the dialog: one modal per round end, and at a boosted rate that
// stalls the client long enough for the server to drop it (measured -
// ConnectionReset on a 8x soak). An unattended soak cannot survive it.
//
// This does not fix the reference's bug and must not: it makes the stock script
// safe to call, then does exactly what the stock line did.

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
