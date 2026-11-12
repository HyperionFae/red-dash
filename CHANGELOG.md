# Changelog

## 0.4.0

### Added
- **Cyber HUD look** — neon glow, glass panels, HUD corner brackets, angled inputs, drifting grid backdrop, faint CRT scanlines, boot-up animation. **FX** button in the status bar switches the effects off (remembered); `prefers-reduced-motion` is respected.
- **Ports bar** — open TCP ports from the box's nmap XML output fill `{PORTS}` automatically and update live while a scan runs. Type your own list to override; **AUTO** switches back.
- **Creds tab** — store user / password / NT hash / note per box. Click a cred to put it in use: `<user>` `<pass>` `<hash>` fill across the playbook, and the terminal header shows who you are acting as.
  - Passwords are masked in the playbook and cred list; values are shell-quoted when inserted, so special characters (`$`, `'`, `` ` ``, spaces) arrive intact.
  - `LM:NT` pairs are accepted — `<hash>` uses the NT half.
- Playbook: pass-the-hash commands (netexec, impacket psexec / secretsdump, evil-winrm), netexec WinRM login and password spray.
- **Toolbox** (⚒ in the top bar):
  - *Reverse shell generator* — pick a type (bash, nc, python3, php, perl, ruby, socat, PowerShell + base64…); LHOST prefills from your VPN IP, LPORT defaults to 4444. Copy or send straight to the terminal, with the matching listener line.
  - *Hash identifier* — paste a hash, get the likely type with the `hashcat -m` mode and `john --format`, and a one-click **crack** command. Knows MD5/NTLM/LM, the SHA family, bcrypt, *crypt, Kerberos (roast / AS-REP), NetNTLMv2, MySQL and more.
- **Checklist tab** — each box starts with a default HTB/THM flow (recon → foothold → privesc → flags). Tick steps off (progress bar + a badge on the tab), add your own, or reset to the default.
- Playbook grew to 74 commands: Active Directory (kerbrute, BloodHound, ldapdomaindump, Kerberos TGT, user/policy dumps), Linux & Windows privesc (sudo -l, SUID, capabilities, linpeas/winPEAS, whoami /priv), and pivoting (SSH SOCKS, sshuttle, chisel, ligolo).

- **Downloads**: AppImage and .deb packages, built by GitHub Actions and attached to each release. Installed builds keep data in `~/.config/red-dash`.
- App icon, demo GIF, new README.

### Fixed
- Switching box while a playbook command sat un-run at the prompt glued `cd "<box>"` onto it and **ran it** with junk arguments. The prompt line is now cleared first.

### Changed
- Electron 45.2.1 → 45.3.1.
- `package.json` license corrected to MIT (matches LICENSE); added repository field.

## 0.3.0
- Dependency upgrades, sandboxed UI with strict CSP, tactical HUD facelift.
