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

The tested car sends no ignition, motion or speed data. The program finds driving from the odometer (`vehicle.vehicle.travelledDistance`) and the central lock (`vehicle.cabin.door.status`).

| Situation | Decision |
|---|---|
| The odometer rose after the last driver door opening, in the last 30 minutes | Driving. No notification. |
| The odometer rose, then the driver door opened | The driver left. Parking starts. |
| The odometer did not rise for 30 minutes | Parked. A traffic jam can stop the odometer for more than 10 minutes. |
| The program has no odometer data | A part that is open for 10 minutes causes a notification. |
| The lock is `LOCKED` and no door opened after that | Driving. The car locks itself when it starts to drive. No notification. |
| The lock changes from `LOCKED` to `UNLOCKED` | The drive ended. The car unlocks itself when you park. The wait starts again. |
| The lock is `SECURED` after the last door opening | Parked and locked from outside. A part that was open at the lock causes a notification at once. |

If your car sends `isIgnitionOn` or `isMoving`, the program uses them too.

## Notification rules

| Rule | Default | Setting in `config.json` |
|---|---|---|
| Wait time after the last driver door opening | 10 minutes | `alert_after_min` |
| Wait time after you lock the car from outside | 0 (at once) | `alert_after_lock_min` |
| Reminders after the first notification | 30 and 90 minutes | `remind_after_min` (`[30, 90]`) |
| Odometer idle time that counts as parked | 30 minutes | `park_after_idle_min` |
| Language of the notification text | `en` | `language` (`en` or `tr`) |
| Time zone of the times in the notification | the server time zone | `timezone` (example: `Europe/Istanbul`) |
| Notification when the car sends no data | off | `silence_alert_hours` (example: `72`) |

- **Why 10 minutes.** The driver door also opens when the driver gets in. In the test car, the first odometer value came 3 to 7 minutes after the driver got in. A wait of 10 minutes covers that time. The timer starts again at each driver door opening.
- **At once after the lock.** A part that is open when you lock the car is a forgotten part. The program checks every 15 seconds, so the notification comes in 15 seconds. You are still near the car. A part that opens after the lock, for example the trunk, follows the normal 10 minute wait.
- **Comfort close.** If you hold the lock button to close the windows and the sunroof, you can get "left open" and then "everything is closed". To prevent this, set `alert_after_lock_min` to 1.
- **Reminders.** Two reminders come: 30 and 90 minutes after the first notification. Then the program is silent until all parts close or a new part opens. A new part starts a new series.
- **Back at the car.** When a door opens after a notification, the remaining reminders stop. If a part is still open when you lock the car again, a new series starts when the car stays locked for 2 minutes. An unlock in these 2 minutes starts the wait again, so a walk around the car with many locks and unlocks gives one notification. If you leave without a lock, the new series starts after the normal wait. After a drive, the first lock notifies at once. An unlock and a lock without a door opening change nothing. A key button or a key near the car, for example at a valet, can do this many times.
- **One message.** A notification lists all open parts. Parts with the same time share it. The windows (or the doors) of one time share their name, for example "sunroof (tilted) since 15:45, left and right front windows and front left door since 16:54". All four windows give "all windows". The oldest time comes first.
- **Time of each part.** A part shows "since 13:48". This is the time the program first saw the part open. If the part was already open before the park (during the drive or since an earlier day), the time is the start of the park: the lock from outside, or the time the driver got out. A lock more than 10 minutes later does not change this time. For an earlier day, the notification shows the date too, for example "since 6 Oct 13:48". After a restart, the program keeps these times. It reads `state.json` and the messages of the last 24 hours. If the program was off for more than 24 hours, a part that is open for longer shows the start of the replay as its time.
- **A new part opens.** After the wait time you get a new notification. It lists all open parts.
- **All parts close.** You get one message that says everything is closed. This message follows an earlier notification. The program sends it only after it sees a part close. Missing data does not count as closed. Only the values `CLOSED` and `false` count as closed. An unknown value does not change the state.
- **You drive again.** The program forgets the old notification. The next parking can send a new one. One part stays: if a part was still open at the last notification and you close it later, you get "everything is closed", also after a drive. After a drive the message comes when you park, not during the drive.
- **More than one car.** The stream sends the messages of all cars of the account. The program watches each car alone. The title then names the car: the name from `vehicle_names`, or the last 4 characters of the VIN. Example: "MINI left open (Countryman)".

## What happens after a failure

- **Token refresh.** The stream password (ID token) is valid for 1 hour. The program refreshes it 5 minutes before it expires. The refresh key is valid for 2 weeks. The key gets a new date at each refresh. If the server is off for more than 2 weeks, you must log in again.
- **Connection loss.** After a healthy connection closes, the program reconnects in 5 seconds. After repeated short connections the wait time doubles up to 60 seconds. BMW limits many connection attempts.
- **Restart.** The program saves the open parts, the odometer and the sent notifications in `state.json`. It saves at once after a notification, else at most once a minute. At a start it reads `state.json` and the messages of the last 24 hours. The same notification does not repeat. The program skips a broken line in the history.
- **History file.** `messages.jsonl` grows to 10 MB. Then it becomes `messages.jsonl.1` and a new file starts. The program keeps two files at most. A message larger than 64 KB is not stored.
- **Memory.** The program uses about 40 MB. It may use at most 250 MB. Above that, systemd restarts only the program. The swap file keeps the server reachable when the memory is full.
- **Stuck program.** The program tells systemd every 30 seconds that it runs (watchdog). If its main loop stops for 10 minutes, systemd restarts the service.
- **ntfy is not reachable.** The program does not count the notification as sent. It tries again after 30 seconds. Each next try waits twice as long, up to 10 minutes.
- **Subscription error.** If the stream refuses the subscription, the program closes the connection and connects again.
- **Full state in each message.** The car sends all selected attributes in each message. A lost message does not hide a state for long.

## More events later

The program watches only doors, windows, sunroof, trunk and hood. CarData has more attributes. A new event needs a change in the code. Open an issue to ask for one.

## Technical details

| Item | Value |
|---|---|
| Login | OAuth 2.0 Device Code Flow with PKCE, `customer.bmwgroup.com/gcdm/oauth` |
| Scopes | `authenticate_user openid cardata:streaming:read cardata:api:read`. BMW's guide asks for both CarData scopes. The program uses only the stream and does not keep the access token. A login with only the stream scope is not tested. |
| Stream | MQTT 3.1.1, `customer.streaming-cardata.bmwgroup.com:9000`, TLS 1.3 required |
| MQTT user and password | GCID and ID token |
| Topic | `<GCID>/+` (all cars of the account) |
| Keepalive | 30 seconds. The broker closes a connection with a 60 second keepalive. |
| QoS | 0. The broker supports only QoS 0. |

The system Python on macOS uses LibreSSL. It does not support TLS 1.3. For this reason the program uses Node.js.

**Next step:** Go to [Step 1, the CarData portal](02-cardata-portal.md).
