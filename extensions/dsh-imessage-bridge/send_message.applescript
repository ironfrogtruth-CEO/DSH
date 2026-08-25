on run argv
    if (count of argv) < 2 then error "recipient and text are required"
    set recipientAddress to item 1 of argv
    set messageText to item 2 of argv
    set attachmentPath to ""
    if (count of argv) ≥ 3 then set attachmentPath to item 3 of argv

    tell application "Messages"
        set messageService to first service whose service type is iMessage and enabled is true
        set targetBuddy to buddy recipientAddress of messageService
        send messageText to targetBuddy
        if attachmentPath is not "" then
            send (POSIX file attachmentPath as alias) to targetBuddy
        end if
    end tell
    -- This is only the local AppleScript handoff result; it is not delivery proof.
    return "queued-to-Messages"
end run
