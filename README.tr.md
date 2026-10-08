# mini-bmw-cardata-notification

**MINI ya da BMW'nde bir kapı, cam, cam tavan, bagaj veya kaput açık kalırsa telefonuna bildirim düşer.**

[English README](README.md)

Başlamak için: [1. adım, kurulum rehberi](docs/tr/02-cardata-portali.md). Kurulum yaklaşık 1 saat sürer.

## Ne işe yarar?

Program, BMW Group'un CarData servisinden araç verisini okur. Aracı park edip bir parçayı açık unutursan telefonuna bildirim düşer.

Örnek bildirim:

> **MINI açık kaldı**
> Açık: sağ ön cam, cam tavan (aralık)

Program yalnızca veri okur. Araca hiçbir komut yollamaz.

## Hangi araçla test edildi?

| Öğe | Değer |
|---|---|
| Araç | **MINI Countryman E (U25)** |
| Ülke | Türkiye |
| Telefon | iPhone. Android'de denenmedi. [Telefon notlarına](docs/tr/03-ntfy.md#telefon-notları) bak. |
| Sunucu | Google Cloud ücretsiz sunucu (e2-micro, Ubuntu 24.04) |

Diğer MINI ve BMW modelleri de çalışabilir ama **garanti yok.** Her model farklı veri yollar. Programın hangi veriye ihtiyaç duyduğunu [Nasıl çalışır](docs/tr/01-nasil-calisir.md) sayfasında bulabilirsin.

## Proje durumu

Bu proje çok yeni. Henüz kimsenin fark etmediği hatalar olabilir. Yazar projeyi yalnızca tek bir araçla test etti.

Program kapıları, camları, cam tavanı, bagajı ve kaputu izliyor. CarData'da daha fazla veri var, örneğin alarm durumu. İleride yeni olaylar eklenebilir. Ayarlar ve davranışlar sürümler arasında değişebilir.

Bir hata mı buldun ya da yeni bir olay mı istiyorsun? Bu depoda bir issue aç.

## 5 adımda kurulum

| Adım | Rehber | Süre |
|---|---|---|
| 1 | [MINI portalında CarData'yı aç](docs/tr/02-cardata-portali.md) | 15 dk |
| 2 | [Telefona ntfy uygulamasını kur](docs/tr/03-ntfy.md) | 5 dk |
| 3 | [Ücretsiz sunucu aç ve programı başlat](docs/tr/04-sunucu-kurulumu.md) | 30 dk |
| 4 | [Programı çalıştır ve güncelle](docs/tr/05-isletim.md) | gerekince |
| 5 | [Nasıl çalıştığını öğren](docs/tr/01-nasil-calisir.md) | isteğe bağlı |

## Başlamadan önce neler lazım?

- Bağlantılı bir MINI veya BMW. Araç, MINI ya da My BMW uygulamasında görünmeli. Ana kullanıcı da sen olmalısın.
- O uygulamanın hesabı (MINI ID veya BMW ID).
- ntfy uygulamasını kuracağın bir telefon (iPhone veya Android).
- Bir Google hesabı ve ödeme kartı. Google, kayıt sırasında kart ister. Sunucu ücretsiz sınırlar içinde kalır.
- Tarayıcısı olan bir bilgisayar.

## Bildirim ne zaman düşer?

| Durum | Bildirim |
|---|---|
| Aracı park edip indin, bir parça açık kaldı | 10 dakika sonra. Aracı kilitlersen hemen. |
| Parça hâlâ açık | 1, 2 ve 4 saat sonra, sonra 8 saatte bir hatırlatma |
| Her şeyi kapattın | "Her şey kapandı" diyen tek bir mesaj |
| Araç yolda | Bildirim yok |

Tek bildirim, açık olan tüm parçaları sıralar. Süreleri `config.json` dosyasından değiştirebilirsin.

## Sınırlar

- **Kilit durumu her araçta yok.** Test edilen araç merkezi kilit bilgisini (`vehicle.cabin.door.status`) yolluyor. Program böylece aracı kilitlediğini ve aracın yolda olduğunu anlar. Bu bilgi yoksa yalnızca "park edildi ve açık" durumuna bakar.
- **Test edilen araç kontak ve hız bilgisi yollamıyor.** Program, aracın yolda olduğunu kilometre sayacından ve kilitten anlar.
- **Kilitlemezsen bildirim, sürücü kapısı açıldıktan 10 dakika sonra gelir.** Araç ilk kilometre verisini yola çıktıktan 3-7 dakika sonra yollar. Daha kısa bir bekleme, yola çıkarken yanlış bildirim üretir.
- **Sürücü kapısı açılmadan uzun süre durursan** (30 dakika veya daha fazla) araç park edilmiş sayılır.
- **Hesap başına tek bağlantı var.** Programı aynı hesapla iki yerde çalıştırma.
- **BMW servisi değiştirebilir.** Program habersiz çalışmayı bırakabilir.

## Gizlilik ve güvenlik

- `config.json` ve `tokens.json` yalnızca sunucunda durur. Bu depoda yoktur.
- `tokens.json`, araç hesabına okuma erişimi verir. Dosyayı kimseyle paylaşma.
- ntfy konu adı parola gibi davranır. Uzun ve rastgele bir ad seç.
- Bildirimler ntfy.sh sunucusundan geçer. Metinde konum, plaka ya da VIN yoktur.
- Sunucu dışarıdan gelen hiçbir bağlantıyı kabul etmez. SSH yalnızca Google IAP tüneliyle açılır.
- Erişimi istediğin zaman kapatabilirsin. MINI portalında "Delete stream" ve "Delete Client" düğmelerine bas.

## Sorumluluk reddi

Bu proje resmî değildir. BMW Group ve MINI projeyi desteklemez. BMW, MINI ve CarData, sahiplerinin ticari markalarıdır. Projenin onlarla bir bağı yoktur.

Programı kendi sorumluluğunda kullanırsın. Güvenlikle ilgili bir konuda tek kontrol yöntemin bu program olmasın. Portaldaki CarData kullanım şartlarına uy.

## Geliştiriciler ve yapay zekâ araçları için

Bir yapay zekâ aracı kurulumda yardım edebilir. Ona bu repoyu ver. Araç [AGENTS.md](AGENTS.md) dosyasını okur. Giriş, kart ve onay adımlarını kullanıcı yapmalı.

```bash
npm ci
npm test
```

Testler sahte araç verisiyle çalışır. Hesap gerekmez. Issue ve pull request açabilirsin.

## Lisans

[MIT](LICENSE)

**Sıradaki adım:** [1. adım](docs/tr/02-cardata-portali.md) rehberini aç.
