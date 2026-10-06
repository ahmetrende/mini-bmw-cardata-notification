# How it works

[Türkçe](../tr/01-nasil-calisir.md) · [README](../../README.md)

This page is optional. Read it to learn what the program does and which data it needs.

## Data path

1. The car sends status changes to the BMW server. Examples: a door opened, a window closed, the odometer rose. Every connected car does this.
2. You turn on a CarData stream in the portal. BMW puts your data in an MQTT stream.
3. The program connects to the stream with TLS and listens.
4. The program decides that a part stayed open. It sends a message to ntfy.sh.
5. The ntfy app shows a notification on your phone.

The program does not connect to the car. It does not wake the car.

## Parts the program watches

| Part | CarData attribute | Open value |
|---|---|---|
| 4 doors | `vehicle.cabin.door.row{1,2}.{driver,passenger}.isOpen` | `true` |
| 4 windows | `vehicle.cabin.window.row{1,2}.{driver,passenger}.status` | `OPEN`, `INTERMEDIATE` |
| Sunroof (slide) | `vehicle.cabin.sunroof.status` | `OPEN`, `INTERMEDIATE` |
| Sunroof (tilt) | `vehicle.cabin.sunroof.tiltStatus` | `OPEN`, `INTERMEDIATE` |
| Trunk | `vehicle.body.trunk.isOpen`, `vehicle.body.trunk.door.isOpen` | `OPEN`, `INTERMEDIATE`, `true` |
| Hood | `vehicle.body.hood.isOpen` | `true` |

Your car must send these attributes. The portal shows the list of attributes for your car. Step 1 of the setup shows how to read it.

## Driving and parking

The tested car sends no ignition, motion or speed data. The program finds driving from the odometer (`vehicle.vehicle.travelledDistance`).

| Situation | Decision |
|---|---|
| The odometer rose in the last 10 minutes | Driving. No notification. |
| The odometer rose, then the driver door opened | The driver left. Parking starts. |
| The odometer did not rise for 10 minutes | Parked. |
| The program has no odometer data | A part that is open for 3 minutes causes a notification. |

If your car sends `isIgnitionOn` or `isMoving`, the program uses them too.

## Notification rules

| Rule | Default | Setting in `config.json` |
|---|---|---|
| Wait time after parking | 3 minutes | `alert_after_min` |
| Reminder when a part is still open | 60 minutes | `remind_every_min` |
| Odometer idle time that counts as parked | 10 minutes | `park_after_idle_min` |
| Language of the notification text | `en` | `language` (`en` or `tr`) |
| Time zone of the times in the notification | the server time zone | `timezone` (example: `Europe/Istanbul`) |

- **One message.** A notification lists all open parts. The oldest part comes first.
- **Time of each part.** A part shows "since 13:48". This is the time the program first saw the part open. For an earlier day, the notification shows the date too, for example "since 6 Oct 13:48". After a restart, the program replays the messages of the last 24 hours. It keeps the original times from that period. A part that was open for more than 24 hours shows the start of the replay as its time.
- **A new part opens.** After the wait time you get a new notification. It lists all open parts.
- **All parts close.** You get one message that says everything is closed. This message follows an earlier notification. The program sends it only after it sees a part close. Missing data does not count as closed.
- **You drive again.** The program forgets the old notification. The next parking can send a new one.

## What happens after a failure

- **Token refresh.** The stream password (ID token) is valid for 1 hour. The program refreshes it 5 minutes before it expires. The refresh key is valid for 2 weeks. The key gets a new date at each refresh. If the server is off for more than 2 weeks, you must log in again.
- **Connection loss.** After a healthy connection closes, the program reconnects in 5 seconds. After repeated short connections the wait time doubles up to 60 seconds. BMW limits many connection attempts.
- **Restart.** The program replays the messages of the last 24 hours. It keeps the odometer and door history. It saves sent notifications in `state.json`. The same notification does not repeat.
- **Full state in each message.** The car sends all selected attributes in each message. A lost message does not hide a state for long.

## More events later

The program watches only doors, windows, sunroof, trunk and hood. CarData has more attributes. A new event needs a change in the code. Open an issue to ask for one.

## Technical details

| Item | Value |
|---|---|
| Login | OAuth 2.0 Device Code Flow with PKCE, `customer.bmwgroup.com/gcdm/oauth` |
| Scopes | `authenticate_user openid cardata:streaming:read cardata:api:read` |
| Stream | MQTT 3.1.1, `customer.streaming-cardata.bmwgroup.com:9000`, TLS 1.3 required |
| MQTT user and password | GCID and ID token |
| Topic | `<GCID>/+` (all cars of the account) |
| Keepalive | 30 seconds. The broker closes a connection with a 60 second keepalive. |
| QoS | 0. The broker supports only QoS 0. |

The system Python on macOS uses LibreSSL. It does not support TLS 1.3. For this reason the program uses Node.js.

**Next step:** Go to [Step 1, the CarData portal](02-cardata-portal.md).
