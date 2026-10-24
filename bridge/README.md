# CommunityOS site bridge

A small program that runs at the gate, on the same network as the entry devices. It talks to each device in the device's own
protocol (Hikvision ISAPI for now) and connects **out** to CommunityOS over HTTPS. No port is opened at the gate.

- It puts the right people on each device (user, card number and face), and takes them off again. CommunityOS decides who.
- It reads every punch (a face, a card or a QR code at the terminal) and sends it to CommunityOS. Each punch is sent once.
- It keeps punches on disk while the internet is down, and sends them when it comes back.
- It opens a door when the security desk asks, sets a device's clock that has drifted, and reports each device's health.

The device lets people in or keeps them out on its own, so the gate keeps working with no internet. CommunityOS records each
punch as a gate visit and, for staff, as attendance. It flags anything its rules would have held, such as a blocked or reported
person, someone outside their hours, someone not on the roster, or a face it does not know.

## What you need

- An always-on computer at the gate: a mini PC or a Raspberry Pi 4/5 is enough. It needs Node.js 20 or later.
- That computer and the terminals on the same network, with a fixed IP address for each terminal.
- Outbound HTTPS from that computer to your CommunityOS address.

## 1. Prepare the terminal (DS-K1T344MBWX-QRE1 and its family)

On the terminal's web page (its IP address, in a browser):

1. Set a strong **admin password**. You enter it once in CommunityOS, where it is stored encrypted and given only to this bridge.
2. Under Network → Advanced → Integration Protocol, **enable ISAPI**. Under Security, set web authentication to **Digest**.
3. Give it a **fixed IP address**.
4. Set the time zone. You can also point it at an NTP server. If its clock drifts more than 30 seconds, the bridge sets it.

The bridge never retries a refused password in a loop. These terminals lock the admin user for 30 minutes after about five
refused logins. After two refusals the bridge leaves the device alone for 30 minutes. Correcting the password in CommunityOS
lifts that pause at once.

## 2. Add the bridge and the device in CommunityOS

1. Go to **On site → Devices → Bridges → Add bridge**. Copy the token: it is shown once.
2. Go to **Add device**. Choose Face terminal and the Hikvision (ISAPI) driver, then enter the terminal's IP address and admin
   password.
3. Choose which way the device counts:
   - **In** for an entry-only terminal, **Out** for an exit-only one.
   - **Both** for a single terminal at the gate. With Both, the terminal's check-in/check-out key decides. Without it, the
     direction alternates: if the person is inside, the punch counts as going out.
4. To put people on the device, record their consent: on the person in the gate registry, or on the staff member for staff
   (staff can also record their own, with their own photo). Only people with consent go on a device. Registry people must also
   be cleared and have a unit they work for, or a place on an active work roster.

## 3. Run the bridge

```sh
cd bridge
COS_SERVER=https://your-communityos.example.org \
COS_BRIDGE_TOKEN=cosb_... \
COS_STATE_DIR=/var/lib/cos-bridge \
npm start
```

The settings can also go in a JSON file named by `COS_BRIDGE_CONFIG`. Settings in the environment win over the file.

| Setting | Default | |
|---|---|---|
| `COS_SERVER` | (none) | The CommunityOS address. |
| `COS_BRIDGE_TOKEN` | (none) | The bridge's token from step 2. |
| `COS_STATE_DIR` | `./state` | Where punches waiting to be sent, and each device's read position, are kept. |
| `COS_EVENT_PHOTOS` | `refused` | Which punches carry the terminal's snapshot: `refused` (refusals and unknown people), `all` or `none`. |
| `COS_DEVICE_TLS_STRICT` | `false` | Set to `true` to require a valid certificate from a terminal on https. |
| `COS_PASS_MINORS`, `COS_FAIL_MINORS` | (none) | Extra event codes for firmware that reports other codes (see below). |
| `COS_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

### As a service (Linux, systemd)

```ini
# /etc/systemd/system/cos-bridge.service
[Unit]
Description=CommunityOS site bridge
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/cos-bridge
ExecStart=/usr/bin/node bin/cos-bridge.js
Environment=COS_SERVER=https://your-communityos.example.org
Environment=COS_STATE_DIR=/var/lib/cos-bridge
EnvironmentFile=/etc/cos-bridge.env
Restart=always
RestartSec=5
User=cosbridge

[Install]
WantedBy=multi-user.target
```

Put `COS_BRIDGE_TOKEN=cosb_...` in `/etc/cos-bridge.env` with mode 600. Then run
`systemctl enable --now cos-bridge`, and follow the log with `journalctl -u cos-bridge -f`.

On Windows, run `node bin\cos-bridge.js` as a service with NSSM, or from Task Scheduler at start-up, with the same settings.

## Event codes

The terminal reports each punch with a "minor" code. The bridge sends these codes as punches:

- Passed: card (1), card and PIN (2), 38, face (75) and fingerprint (113).
- Refused: 3, 6, 7, 8, 9, 39 and face not recognised (76).

Any other code, such as a door state, is not sent. The bridge logs each such code once. If your firmware reports a punch under
another code, add it with `COS_PASS_MINORS` or `COS_FAIL_MINORS`. When installing, present a face and a card, then check the
**On site → Live** list.

## Good to know

- **Revoking.** Revoking a bridge in CommunityOS stops its token at once. The bridge keeps reading the devices and holds the
  punches until it gets a new token.
- **Factory reset.** After a terminal is factory reset, its event numbers start again from 1. Add it in CommunityOS as a new
  device, and pause the old entry, which keeps its history. If it stayed the same device, new punches carrying event numbers
  CommunityOS has already seen would be taken as repeats.
- **Your data.** Face photos go from CommunityOS to the terminal, never the other way. The terminal's snapshot of a punch is
  sent only as `COS_EVENT_PHOTOS` says.

## Try it without hardware

```sh
npm test                 # the bridge against a stand-in CommunityOS and a DS-K1T344 stand-in
npm run sim -- --port 8091 --password 'Passw0rd!'
curl -X POST localhost:8091/sim/present -d '{"face":"<employeeNo>"}'   # someone shows their face
```

The stand-in (`sim/ds-k1t344.js`) answers the ISAPI calls the bridge makes. It uses Digest login, including the device's lockout
after five refused logins. It also keeps users, cards, faces, the door, the clock and the event log, and decides at the door as
the device would.
