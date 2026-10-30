# 1. adım / 5: MINI portalında CarData'yı aç

[English](../en/02-cardata-portal.md) · [README](../../README.tr.md)

**Süre: 15 dakika.** Bilgisayardan, tarayıcıyla yap. Portal telefonda hata verebiliyor.

Bu adımda üç şey yapacaksın:
1. CarData'yı aç.
2. Bir Client ID oluştur.
3. Veri akışını ayarla.

Client ID'yi bir yere not et. 3. adımda lazım olacak.

## 1. Portalı aç

1. https://www.mini.co.uk/en-gb/mymini/vehicle-overview adresini aç.
2. MINI ID'nle giriş yap (MINI uygulamasında kullandığın hesap).
3. Aracının listede olduğunu kontrol et. Yoksa önce aracı MINI uygulamasından ekle.

Ülkenin kendi portalı olabilir. İngiltere adresi, Türkiye'deki bir araçta çalıştı. Almanya adresi de (`https://www.mini.de/de-de/mymini/vehicle-overview`) aynı hesapla çalıştı. BMW kullanıyorsan ülkenin My BMW portalına gir.

BMW, CarData için "desteklenen pazar (AB)" şartını yazıyor. Test edilen araç AB dışındaydı ve yine de çalıştı.

## 2. CarData'yı aç

1. Aracını bul ve **MINI CarData** bağlantısını seç.
2. **Activate now** düğmesine bas.
3. Açılan iki pencerede şartları kabul et: genel şartlar ve CarData kullanım şartları.

Sayfanın üstünde kırmızı bir "An error occurred ... (SERVICE)" çubuğu çıkabilir. Bazı listeler yüklenmemiş demek. Bu hata kurulumu engellemedi. Devam et.

## 3. Client ID oluştur

1. **Technical access to MINI CarData** bölümüne kadar in.
2. **Create CarData Client** düğmesine bas.
3. **Client ID** satırı çıkar. Örnek: `1a2b3c4d-1111-2222-3333-444455556666`
4. Client ID'yi kopyala ve sakla.

## 4. Servislere abone ol

Kutuda iki anahtar var. Anahtarları **bu sırayla** aç:

1. **Request access to CarData API** anahtarını aç.
2. **60 saniye bekle.** BMW sunucusunun izni etkinleştirmesi biraz sürüyor.
3. **CarData Stream** anahtarını aç.
4. 60 saniye daha bekle.

**Authenticate device** düğmesine şimdi basma. O düğmeyi 3. adımda, program bir kod üretince kullanacaksın.

## 5. Veri akışını ayarla

1. **CarData Streaming** bölümünde **Configure data stream** düğmesine bas.
2. Arama kutusunu kullan. Aşağıdaki tablodaki öznitelikleri bul ve her birini işaretle.
3. **Show selected attributes only** anahtarına bas ve listeni kontrol et. En az 14 satır olmalı.
4. **Submit and initiate stream** düğmesine bas.
5. Ana sayfada **Configuration status** değerinin **ready** olduğunu kontrol et.

**Zorunlu öznitelikler:**

| Aranacak | İşaretlenecek |
|---|---|
| `window.row` | 4 cam: `row1.driver`, `row1.passenger`, `row2.driver`, `row2.passenger` (`...window.rowX.Y.status`) |
| `isOpen` | 4 kapı: `vehicle.cabin.door.rowX.Y.isOpen` |
| `isOpen` | `vehicle.body.trunk.isOpen`, `vehicle.body.trunk.door.isOpen`, `vehicle.body.hood.isOpen` |
| `sunroof` | `vehicle.cabin.sunroof.status`, `vehicle.cabin.sunroof.tiltStatus` |
| `travelledDistance` | `vehicle.vehicle.travelledDistance` (program, aracın yolda olduğunu bununla anlıyor) |

**İsteğe bağlı öznitelikler:**

| Öznitelik | Ne işe yarar? |
|---|---|
| `vehicle.cabin.door.status` | Merkezi kilit. Önerilir. Aracı kilitlediğin anda bildirim gelir. Program aracın yolda olduğunu da anlar. Test edilen araç yolluyor. |
| `vehicle.drivetrain.engine.isIgnitionOn` | Kontak durumu. Test edilen araç yollamadı. |
| `vehicle.isMoving` | Hareket durumu. Test edilen araç yollamadı. |
| `vehicle.cabin.sunroof.overallStatus` | Cam tavanın genel durumu. Program yalnızca kaydeder. |
| `vehicle.powertrain.electric.battery.stateOfCharge.displayed` | Batarya seviyesi (yüzde). `notify_battery` ayarı için. Elektrikli ve hibrit araçlarda. Denenmedi. Alternatif: `vehicle.drivetrain.batteryManagement.header`. |
| `vehicle.drivetrain.electricEngine.kombiRemainingElectricRange` | Kalan elektrik menzili. `notify_battery` ayarı için. Denenmedi. Alternatifler: `vehicle.drivetrain.electricEngine.remainingElectricRange` ve `vehicle.drivetrain.lastRemainingRange`. |
| `vehicle.drivetrain.electricEngine.charging.status` | Şarj durumu: `INITIALIZATION`, `CHARGINGACTIVE`, `CHARGINGPAUSED`, `CHARGINGENDED`, `CHARGINGERROR` veya `NOCHARGING`. `notify_battery` ayarı için. Test edilen araç yolluyor. |
| `vehicle.body.chargingPort.status` | Fiş durumu: `CONNECTED` veya `DISCONNECTED`. `notify_battery` ayarı için. Test edilen araç yolluyor. |

Portal, araç tipine uygun öznitelikleri gösterir. Akış ise yalnızca aracının desteklediklerini yollar. Eksik bir öznitelik hata vermez, ama o parça için bildirim çalışmaz.

## Yedek: yazarın tam seçim listesi

Yazarın akışında bu 38 öznitelik var. Program yalnızca "zorunlu", "önerilir" ya da bir ayar adı yazan özniteliklere ihtiyaç duyar. Diğerleri isteğe bağlı. Portal listeni kaybederse bu öznitelikleri **Change data selection** ile yeniden işaretle.

| Öznitelik | Ne için | Test edilen araç yolluyor mu? |
|---|---|---|
| `vehicle.vehicle.travelledDistance` | Sürüş tespiti (zorunlu) | evet |
| `vehicle.cabin.door.status` | Kilit durumu: başlıklar, kilit onayı, sürüş tespiti (önerilir) | evet |
| `vehicle.cabin.door.row1.driver.isOpen` | Kapı durumu (zorunlu) | evet |
| `vehicle.cabin.door.row1.passenger.isOpen` | Kapı durumu (zorunlu) | evet |
| `vehicle.cabin.door.row2.driver.isOpen` | Kapı durumu (zorunlu) | evet |
| `vehicle.cabin.door.row2.passenger.isOpen` | Kapı durumu (zorunlu) | evet |
| `vehicle.cabin.window.row1.driver.status` | Cam durumu, tam ya da kısmen açık (zorunlu) | evet |
| `vehicle.cabin.window.row1.passenger.status` | Cam durumu, tam ya da kısmen açık (zorunlu) | evet |
| `vehicle.cabin.window.row2.driver.status` | Cam durumu, tam ya da kısmen açık (zorunlu) | evet |
| `vehicle.cabin.window.row2.passenger.status` | Cam durumu, tam ya da kısmen açık (zorunlu) | evet |
| `vehicle.cabin.sunroof.status` | Cam tavan durumu (zorunlu) | evet |
| `vehicle.cabin.sunroof.tiltStatus` | Cam tavan aralık durumu (zorunlu) | evet |
| `vehicle.body.trunk.isOpen` | Bagaj durumu (zorunlu) | evet |
| `vehicle.body.trunk.door.isOpen` | Bagaj durumu (zorunlu) | evet |
| `vehicle.body.hood.isOpen` | Kaput durumu (zorunlu) | evet |
| `vehicle.drivetrain.batteryManagement.header` | Batarya seviyesi (`notify_battery`) | evet |
| `vehicle.drivetrain.electricEngine.kombiRemainingElectricRange` | Menzil (`notify_battery`) | evet |
| `vehicle.drivetrain.lastRemainingRange` | Menzil, alternatif (`notify_battery`) | evet |
| `vehicle.drivetrain.electricEngine.charging.status` | Şarj durumu (`notify_battery`) | evet |
| `vehicle.body.chargingPort.status` | Fiş durumu (`notify_battery`) | evet |
| `vehicle.cabin.sunroof.overallStatus` | Cam tavanın genel durumu. Program yalnızca kaydeder. | evet |
| `vehicle.cabin.sunroof.relativePosition` | Cam tavan açıklığı (yüzde). Kullanılmıyor. | hayır |
| `vehicle.drivetrain.engine.isIgnitionOn` | Kontak durumu. Araç yollarsa program kullanır. | hayır |
| `vehicle.isMoving` | Hareket durumu. Araç yollarsa program kullanır. | hayır |
| `vehicle.powertrain.electric.battery.stateOfCharge.displayed` | Batarya seviyesi, alternatif (`notify_battery`) | hayır |
| `vehicle.drivetrain.electricEngine.remainingElectricRange` | Menzil, alternatif (`notify_battery`) | hayır |
| `vehicle.vehicle.antiTheftAlarmSystem.alarm.armStatus` | Alarm durumu. Kullanılmıyor. | hayır |
| `vehicle.vehicle.speedRange.lowerBound` | Hız aralığı. Kullanılmıyor. | hayır |
| `vehicle.vehicle.speedRange.upperBound` | Hız aralığı. Kullanılmıyor. | hayır |
| `vehicle.body.trunk.isLocked` | Bagaj kilidi. Kullanılmıyor. | hayır |
| `vehicle.powertrain.tractionBattery.charging.port.anyPosition.flap.isOpen` | Şarj kapağı. Kullanılmıyor. | hayır |
| `vehicle.trip.segment.end.travelledDistance` | Son sürüşten sonraki kilometre. Kullanılmıyor. | hayır |
| `vehicle.drivetrain.electricEngine.charging.connectorStatus` | Fiş türü ve durumu. Kullanılmıyor. | hayır |
| `vehicle.drivetrain.electricEngine.charging.hvStatus` | Yüksek gerilim şarj sistemi. Kullanılmıyor. | hayır |
| `vehicle.cabin.door.row1.driver.position` | Kapı açıklığı (yüzde). Kullanılmıyor. 29 Ekim 2026'da test için eklendi. Araç, 78 kapı değişikliği olan 27 saatte hiç değer yollamadı. | hayır |
| `vehicle.cabin.door.row1.passenger.position` | Kapı açıklığı (yüzde). Kullanılmıyor. 29 Ekim 2026'da test için eklendi. Araç, 78 kapı değişikliği olan 27 saatte hiç değer yollamadı. | hayır |
| `vehicle.cabin.door.row2.driver.position` | Kapı açıklığı (yüzde). Kullanılmıyor. 29 Ekim 2026'da test için eklendi. Araç, 78 kapı değişikliği olan 27 saatte hiç değer yollamadı. | hayır |
| `vehicle.cabin.door.row2.passenger.position` | Kapı açıklığı (yüzde). Kullanılmıyor. 29 Ekim 2026'da test için eklendi. Araç, 78 kapı değişikliği olan 27 saatte hiç değer yollamadı. | hayır |

## Portalda karşılaşabileceğin sorunlar

- **"Change data selection" düğmesi ilk basışta çalışmayabilir.** Sayfa değişmezse düğmeye bir kez daha bas.
- **Listeyi değiştirirken hep "Change data selection" düğmesini kullan.** Seçim sayfasının adresini tarayıcıya yazma. O sayfa eski seçimini yüklemez. Seçimi onaylarsan eski liste silinir.
- **"Show selected attributes only" anahtarı bazen tepki vermez.** Bir kez daha bas veya sayfayı yenile.
- **Arama, sözcüğün bir kısmıyla da eşleşir.** `isOpen` araması şarj kapağı gibi başka satırları da getirir. Yalnızca tablodaki satırları işaretle.

## Kontrol

- [ ] Client ID'n var.
- [ ] CarData API ve CarData Stream açık.
- [ ] Akış durumu **ready**.

**Sıradaki adım:** [2. adım, ntfy uygulaması](03-ntfy.md) sayfasına geç.
