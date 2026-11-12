# Strike Lite

A CS-style 5v5 bomb-defusal shooter you play with friends.

## Download

Get **`StrikeLiteLauncher.exe`** from the [latest release](https://github.com/chipisherecan/Strike-lite/releases/latest)
and run it. No account is needed. The launcher installs the game into `%LOCALAPPDATA%\StrikeLite` and updates it
automatically every time it opens. Windows may warn about an unknown publisher because the exe isn't code-signed
(More info > Run anyway).

## Playing with friends

The host clicks **Get link** in the launcher (or **Invite friends** in the game menu) and sends the link it copies.
Friends open the link in Chrome or Edge: no VPN, no admin rights and nothing to install. The link works while the
host's launcher is open; each time the host restarts the game, there is a new one.

The link runs through Cloudflare's free tunnel service (or localhost.run if Cloudflare is blocked), so game traffic
passes through them, encrypted between each player and the service. Only people with the link can join, and friends
never see the host's IP address. Some school or office networks block these services.

**Same network or your own VPN:** turn on **Allow direct LAN / VPN connections** on the launcher's **LAN & VPN**
page and share the address shown under it. Windows then asks to allow Node.js through the firewall, which needs admin on many PCs.

This repository only hosts the game's releases.
