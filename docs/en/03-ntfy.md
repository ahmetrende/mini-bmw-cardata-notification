# Step 2 of 5: Install the ntfy app on your phone

[Türkçe](../tr/03-ntfy.md) · [README](../../README.md)

**Time: 5 minutes.**

[ntfy](https://ntfy.sh) is a free, open-source notification service. It needs no account and no phone number.

## 1. Choose a topic name

The topic name works like a password. Anyone who knows the name can read your notifications. Use a long random name.

Make a random name on your computer:

```bash
echo "mini-$(openssl rand -hex 9)"
```

Example output: `mini-3f9a1c7e2b5d8e0a4c`

This command does not work in Windows PowerShell. On Windows, type a name yourself: `mini-` and then 18 random letters and digits.

Copy the name and keep it. You need it in Step 3.

## 2. Install the app and subscribe

1. Install **ntfy** from the App Store (iPhone) or from Google Play or F-Droid (Android).
2. Open the app. If it asks for notification permission, allow it.
3. Press **+**.
4. Type your topic name.
5. Keep the default server `ntfy.sh`.
6. Press **Subscribe**.

## 3. Test

Send a test notification from your computer. Replace `TOPIC` with your topic name:

```bash
curl -d "Test notification" https://ntfy.sh/TOPIC
```

A notification must arrive on your phone. If it does not arrive, check that notifications are on for ntfy in the phone settings.

## Phone notes

**iPhone.** The author tested the program with an iPhone. Allow notifications when the app asks.

**Android.** The author did **not** test Android. The ntfy documentation gives this advice:

- A phone in doze mode can delay messages. The delay can be many minutes.
- To reduce the delay, turn on instant delivery in the ntfy settings. The option has the name "Subscription Service".
- The F-Droid build uses instant delivery for all subscriptions by default.

Menu names can change between app versions. If a notification is late on Android, check these settings first.

## Security

- Notifications are not end-to-end encrypted. The ntfy.sh server can read the text.
- The text only names the open parts and the time, for example "Open: front right window since 13:50". It has no location, plate number or VIN.
- For more privacy, run your own ntfy server. Then set `ntfy_server` in `config.json`.

**Next step:** Go to [Step 3, the server setup](04-server-setup.md).
