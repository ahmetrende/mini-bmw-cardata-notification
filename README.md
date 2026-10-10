# mini-bmw-cardata-notification

**Get a phone notification when a door, window, sunroof, trunk or hood stays open on your MINI or BMW.**

[Türkçe README](README.tr.md)

Start here: [Step 1 of 5, the setup guide](docs/en/02-cardata-portal.md). The full setup takes about 1 hour.

## What it does

The program reads the data stream of the BMW Group CarData service. You park the car and leave a part open. A notification arrives on your phone.

Example notification:

> **MINI left open**
> Open: sunroof (tilted) since 13:48, front right window since 13:50

The program only reads data. It sends no command to the car.

## Tested with

| Item | Value |
|---|---|
| Car | **MINI Countryman E (U25)** |
| Country | Türkiye |
| Phone | iPhone. Android was not tested. See the [phone notes](docs/en/03-ntfy.md#phone-notes). |
| Server | Google Cloud free server (e2-micro, Ubuntu 24.04) |

Other MINI and BMW cars may work. There is **no guarantee**. Each model sends different data. Read [How it works](docs/en/01-how-it-works.md) to see which data the program needs.

## Project status

This project is new. It can have bugs that nobody found yet. The author tested it with one car only.

The program watches doors, windows, sunroof, trunk and hood. CarData has more data, for example the alarm state. New events can come later. The settings and the behavior can change between versions.

Found a problem, or do you need a new event? Open an issue in this repository.

## Set up in 5 steps

| Step | Guide | Time |
|---|---|---|
| 1 | [Turn on CarData in the MINI portal](docs/en/02-cardata-portal.md) | 15 min |
| 2 | [Install the ntfy app on your phone](docs/en/03-ntfy.md) | 5 min |
| 3 | [Create a free server and start the program](docs/en/04-server-setup.md) | 30 min |
| 4 | [Run and update the program](docs/en/05-operations.md) | when needed |
| 5 | [Learn how it works](docs/en/01-how-it-works.md) | optional |

## What you need

- A connected MINI or BMW. The car must show in the MINI or My BMW app. You must be the primary user.
- The account of that app (MINI ID or BMW ID).
- A phone for the ntfy app (iPhone or Android).
- A Google account and a payment card. Google asks for the card at sign-up. The server stays inside the free limits.
- A computer with a web browser.

## When do you get a notification?

| Situation | Notification |
|---|---|
| You park, leave the car, and a part stays open | After 10 minutes. At once when you lock the car. |
| A part is still open | Reminders 30 and 90 minutes after the first notification. Then no more. They stop when you come back to the car. |
| You close all parts | One message that says everything is closed |
| You lock the car and all parts are closed | Optional (`lock_confirm`): "locked, everything is closed". It shows that the system works. |
| You drive | No notification |

One notification lists all open parts. Parts with the same time share it. You change the wait times in `config.json`.

## Limits

- **Lock state only on some cars.** The tested car sends the central lock (`vehicle.cabin.door.status`). The program then knows when you lock the car and when the car drives. Without it, the program reacts to "parked and open" only.
- **No ignition or speed data** on the tested car. The program finds driving from the odometer and the lock.
- **Without a lock, the notification comes 10 minutes after the driver door opens.** After a drive starts, the first odometer value comes in 3 to 7 minutes. A shorter wait gives false notifications at the start of a drive.
- **A long stop without the driver door opening** (30 minutes or more) counts as parked.
- **One connection for each account.** Do not run the program twice with the same account.
- **BMW can change the service.** The program can stop working without notice.

## Privacy and security

- `config.json` and `tokens.json` stay on your server. They are not in this repository.
- `tokens.json` gives read access to your car account. Do not share it.
- The ntfy topic name works like a password. Use a long random name.
- Notifications go through the ntfy.sh server. The text has no location, plate number or VIN.
- The server accepts no incoming connection. SSH works only through the Google IAP tunnel.
- You can delete all access in the MINI portal. Press "Delete stream" and "Delete Client".

## Disclaimer

This is an unofficial project. BMW Group and MINI do not support it. BMW, MINI and CarData are trademarks of their owners. This project has no connection with them.

You use the program at your own risk. Do not use it as your only check for a safety or security matter. Obey the CarData terms of use in your portal.

## For developers and AI tools

An AI coding tool can help with the setup. Give it this repository. It reads [AGENTS.md](AGENTS.md). The person must do the login, card and consent steps.

```bash
npm ci
npm test
```

The tests use fake car data. They need no account. Issues and pull requests are welcome.

## License

[MIT](LICENSE)

**Next step:** Open [Step 1](docs/en/02-cardata-portal.md).
