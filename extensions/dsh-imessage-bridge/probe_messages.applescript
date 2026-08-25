on run argv
    -- Read-only Automation probe. No message is read, composed, or sent.
    tell application "Messages"
        set activeServices to every service whose service type is iMessage and enabled is true
        if (count of activeServices) is 0 then error "No enabled iMessage service"
    end tell
    return "Messages Automation available"
end run
