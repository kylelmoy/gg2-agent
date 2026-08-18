// void agentBridgeLog(string message)
// Appends one line to the bridge log file. Deliberately never shows a dialog:
// anything on the agent path that blocks would hang the game and the agent
// with it.

var fp;
fp = file_text_open_append(global.agentLogFile);
if (fp < 0)
    exit;
file_text_write_string(fp, string(current_time) + "  " + string(argument0));
file_text_writeln(fp);
file_text_close(fp);
