hexchat.register("MarkovRelay", "1.0", "Bridges a channel with the Markov bot via PM")

local NETWORK         = ""
local SOURCE_CHANNELS = { "", "" }
local BOT_NICK        = "markovbot"

local relay_active = (hexchat.pluginprefs["active"] or "1") == "1"
local suppress_echo = false

local function is_source_channel(name)
    for _, ch in ipairs(SOURCE_CHANNELS) do
        if ch:lower() == name:lower() then return true end
    end
    return false
end

hexchat.hook_command("markovrelay", function(args)
    if args[2] and args[2]:lower() == "on" then
        relay_active = true
    elseif args[2] and args[2]:lower() == "off" then
        relay_active = false
    else
        relay_active = not relay_active
    end

    hexchat.pluginprefs["active"] = relay_active and "1" or "0"
    hexchat.print("MarkovRelay: " .. (relay_active and "ON" or "OFF"))
    return hexchat.EAT_ALL
end, "Usage: /markovrelay [on|off]")

hexchat.command('menu add "Settings/Markov Relay Toggle" "markovrelay"')

local function relay_to_bot(message)
    if not relay_active then
        return hexchat.EAT_NONE
    end

    if hexchat.get_info("network") ~= NETWORK then
        return hexchat.EAT_NONE
    end

    if not is_source_channel(hexchat.get_info("channel")) then
        return hexchat.EAT_NONE
    end

    local ctx = hexchat.find_context(NETWORK, hexchat.get_info("channel"))
    if ctx then
        suppress_echo = true
        ctx:command("msg " .. BOT_NICK .. " " .. message)
        suppress_echo = false
    else
        hexchat.print("MarkovRelay: source context not found")
    end

    return hexchat.EAT_NONE
end

hexchat.hook_print("Message Send", function(args)
    if suppress_echo then
        return hexchat.EAT_ALL
    end
    return hexchat.EAT_NONE
end)

hexchat.hook_print("Your Message", function(args)
    return relay_to_bot(args[2])
end)

hexchat.hook_print("Channel Message", function(args)
    if hexchat.nickcmp(args[1], hexchat.get_info("nick")) == 0 then
        return hexchat.EAT_NONE
    end

    return relay_to_bot(args[2])
end)

hexchat.hook_print("Private Message to Dialog", function(args)
    if not relay_active then
        return hexchat.EAT_NONE
    end

    if hexchat.get_info("network") ~= NETWORK then
        return hexchat.EAT_NONE
    end

    if hexchat.nickcmp(args[1], BOT_NICK) ~= 0 then
        return hexchat.EAT_NONE
    end

    for _, ch in ipairs(SOURCE_CHANNELS) do
        local ctx = hexchat.find_context(NETWORK, ch)
        if ctx then
            ctx:command("say " .. args[2])
        end
    end

    return hexchat.EAT_NONE
end)

hexchat.hook_unload(function()
    hexchat.command('menu del "Settings/Markov Relay Toggle"')
end)

hexchat.print("MarkovRelay loaded (" .. (relay_active and "ON" or "OFF") .. ") on " .. NETWORK)