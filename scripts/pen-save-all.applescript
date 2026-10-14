-- Saves every open Pen window. Pen MCP edits stay in memory until saved.
-- Pen has no scripting dictionary, so this raises each window and sends Cmd+S.
-- Untitled windows open a Save dialog; those are cancelled and reported, and the
-- script exits non-zero. The calling app (Terminal, Claude, ...) needs
-- Accessibility permission.
-- Usage: osascript scripts/pen-save-all.applescript
if application "Pen" is not running then return "Pen is not running"
tell application "Pen" to activate
set saved to {}
set unsaved to {}
tell application "System Events" to tell process "Pen"
	set targets to windows
	set windowCount to count of targets
	repeat with w in targets
		set windowName to name of w
		-- AXRaise alone leaves a minimized window unfocused, so Cmd+S would hit another window.
		set value of attribute "AXMinimized" of w to false
		perform action "AXRaise" of w
		delay 0.3
		if not (value of attribute "AXMain" of w) then
			set end of unsaved to windowName & " (could not focus)"
		else
			keystroke "s" using command down
			-- A Save dialog appears as a sheet or as an extra window; poll so a slow one is caught.
			-- shortcut: a dialog slower than 2s is missed, raise the limit if Pen is that slow.
			set hasDialog to false
			repeat 10 times
				delay 0.2
				if (exists sheet 1 of w) or (count of windows) > windowCount then
					set hasDialog to true
					exit repeat
				end if
			end repeat
			if hasDialog then
				key code 53 -- Escape
				delay 0.3
				set end of unsaved to windowName & " (untitled, Save dialog cancelled)"
			else
				set end of saved to windowName
			end if
		end if
	end repeat
end tell
set AppleScript's text item delimiters to linefeed
set report to "Saved " & (count of saved) & " window(s):" & linefeed & (saved as text)
if unsaved is not {} then error report & linefeed & "Not saved:" & linefeed & (unsaved as text) number 1
return report
