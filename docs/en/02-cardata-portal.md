# Step 1 of 5: Turn on CarData in the MINI portal

[Türkçe](../tr/02-cardata-portali.md) · [README](../../README.md)

**Time: 15 minutes.** Use a desktop browser. The portal can fail on a phone.

You do three things here:
1. Turn on CarData.
2. Create a Client ID.
3. Set up the data stream.

Keep the Client ID. You need it in Step 3.

## 1. Open the portal

1. Open https://www.mini.co.uk/en-gb/mymini/vehicle-overview
2. Log in with your MINI ID (the account of the MINI app).
3. Check that your car is in the list. If it is not, add the car in the MINI app first.

Your country can have its own portal. The UK address worked for a car in Türkiye. The German address (`https://www.mini.de/de-de/mymini/vehicle-overview`) also worked with the same account. For a BMW, use the My BMW portal of your country.

BMW lists "a supported market (EU)" as a CarData requirement. The test car was outside the EU and it worked.

## 2. Turn on CarData

1. Find your car. Select **MINI CarData**.
2. Press **Activate now**.
3. Accept the two windows that open: the general terms and the CarData terms of use.

A red bar "An error occurred ... (SERVICE)" can show at the top of the page. It means that some lists did not load. It did not stop the setup. Continue.

## 3. Create a Client ID

1. Scroll to **Technical access to MINI CarData**.
2. Press **Create CarData Client**.
3. A line **Client ID** shows. Example: `1a2b3c4d-1111-2222-3333-444455556666`
4. Copy the Client ID and keep it.

## 4. Subscribe to the services

The box has two switches. Turn them on **in this order**:

1. Turn on **Request access to CarData API**.
2. **Wait 60 seconds.** The BMW server needs time to activate the permission.
3. Turn on **CarData Stream**.
4. Wait 60 more seconds.

Do **not** press **Authenticate device** now. You use that button in Step 3, after the program makes a code.

## 5. Set up the data stream

1. In the section **CarData Streaming**, press **Configure data stream**.
2. Use the search box. Find the attributes in the table below. Tick each one.
3. Press **Show selected attributes only** and check your list. You need 14 lines or more.
4. Press **Submit and initiate stream**.
5. On the main page, check that **Configuration status** shows **ready**.

**Required attributes:**

| Search for | Tick |
|---|---|
| `window.row` | 4 windows: `row1.driver`, `row1.passenger`, `row2.driver`, `row2.passenger` (`...window.rowX.Y.status`) |
| `isOpen` | 4 doors: `vehicle.cabin.door.rowX.Y.isOpen` |
| `isOpen` | `vehicle.body.trunk.isOpen`, `vehicle.body.trunk.door.isOpen`, `vehicle.body.hood.isOpen` |
| `sunroof` | `vehicle.cabin.sunroof.status`, `vehicle.cabin.sunroof.tiltStatus` |
| `travelledDistance` | `vehicle.vehicle.travelledDistance` (the program needs it to find driving) |

**Optional attributes:**

| Attribute | Reason |
|---|---|
| `vehicle.drivetrain.engine.isIgnitionOn` | Ignition state. The tested car did not send it. |
| `vehicle.isMoving` | Motion state. The tested car did not send it. |
| `vehicle.cabin.sunroof.overallStatus` | General sunroof state. The program only records it. |

The portal shows the attributes that exist for your car type. The stream sends only the attributes that your car supports. A missing attribute does not cause an error. The notification for that part does not work.

## Portal problems

- **The button "Change data selection" can fail on the first press.** If the page does not change, press the button again.
- **Always use "Change data selection" to edit the list.** Do not type the selection page address in the browser. That page does not load your old selection. If you submit it, it deletes the old list.
- **The switch "Show selected attributes only" can fail.** Press it again, or reload the page.
- **The search matches part of a word.** The search `isOpen` also shows the charge flap and other lines. Tick only the lines of the table.

## Check

- [ ] You have the Client ID.
- [ ] CarData API and CarData Stream are on.
- [ ] The stream status is **ready**.

**Next step:** Go to [Step 2, the ntfy app](03-ntfy.md).
