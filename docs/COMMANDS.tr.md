# Komut rehberi

Her komutun ne yaptığı, nasıl kullanıldığı, örnekleri ve notları. Telegram'daki
`/help` menüsü aynı komutları sunar — birine dokununca bölümünü alırsın.

## Oturumlar

### /new

**Ne işe yarar**: Seçtiğin projede yeni bir oturum oluşturur, Telegram konusu anında açılır.

**Kullanım**: `/new <başlık?>`

**Örnekler**:
- `/new Satış analizi` → proje seçicisini gösterir; birine dokunmak "Satış analizi" oturumunu orada oluşturur
- `/new` → sohbette başlığı sorar ve başlık girilince seçiciyi gösterir

**Notlar**:
- Geçerli konuşmanın projesi seçicide ilk sırada gelir (✅) — o varsayılandır: tek dokunuş yeter.
- "➕ Yeni proje…" bir ad sorar ve bu klasörü geçerli projenin yanında oluşturur; oturum onun içinde açılır.
- Konu oluşturma anında açılır (eskiden ilk mesajla doğardı): yaz, oturum dinlemeye başlasın.
- Sağlayıcıyı ve modeli yeni konuda seçersin: projenin varsayılan modelinin sağlayıcısında açılır, o model ✅ ile işaretlidir — bir dokunuş korur, ya da diğerlerini keşfet. Sonrasında `/models` ile de aynı.
- `/new` başlıksız gönderilirse, o konudaki bir sonraki mesaj 10 dakika içinde ad olur.

### /use

**Ne işe yarar**: Sohbet kökünden giden mesajların hangi oturuma gideceğini belirler.

**Kullanım**: `/use <ses_id>`

**Örnekler**:
- `/use ses_f2a05826affeXDqtDAtfF23Rud` → kök bu oturumu gösterir
- `/use` → geçerli oturumu gösterir

**Notlar**: Bir konudaki mesajlar `/use`'den bağımsız olarak her zaman o konunun oturumuna gider.

### /fork

**Ne işe yarar**: Bir oturumu son mesajına kadar fork'lar — orijinali kirletmeden fikir dene.

**Kullanım**: `/fork` (konuda) ya da `/fork <ses_id>`

**Örnekler**:
- Bir oturumun konusunda `/fork` → bir fork oluşturur ve bildirir
- `/fork ses_xxx` → her yerden aynı şey

**Notlar**: Fork, kendi konusu olan yeni bir oturumdur. Orijinali bozulmadan kalır.

### /rename

**Ne işe yarar**: Bir oturumu yeniden adlandırır — Telegram konusu ve masaüstü değişimi izler.

**Kullanım**: `/rename <başlık>` ya da `/rename <ses_id> <başlık>`

**Örnekler**:
- `/rename Q4 Analizi` → bu konunun oturumunu yeniden adlandırır
- `/rename` (başlıksız) → transkriptten 3 başlık önerir, tek dokunuşla seçersin

**Notlar**: Başlık 128 karakterle kırılır (Telegram'ın konu adı sınırı).

### /detach

**Ne işe yarar**: Sohbet kökünü oturumundan ayırır — oraya yazdıkların artık hiçbir oturuma gitmez.

**Kullanım**: `/detach`

**Örnekler**:
- `/detach` → kök serbest kalır
- `/use <ses_id>` → yeniden bağlar

**Notlar**: Oturum konuları bundan etkilenmez.

### /archive

**Ne işe yarar**: Konudaki oturumu arşivler — gizli sohbette konuyu siler ve oturumu susturur.

**Kullanım**: `/archive` ya da `/archive <ses_id>`

**Örnekler**:
- Bir konuda `/archive` → konu sohbetten kaybolur
- `/archive ses_xxx` → her yerden aynı şey (id tekil bir önek kabul eder)

**Notlar**: `/unarchive` geri getirir — tek başına arşivdekilerin seçicisini açar, yani id gerekmez.

### /unarchive

**Ne işe yarar**: Arşivlenmiş bir oturumu uyandırır — idsiz seçiciyi açar; metinle proje, başlık ya da id arar.

**Kullanım**: `/unarchive`, `/unarchive <metin>` ya da `/unarchive <ses_id>`

**Örnekler**:
- Kökte `/unarchive` → arşivlenmiş oturumların seçicisini açar, en yeni önce
- `/unarchive faturalar` → uyanlar (başlık, proje ya da id) ile seçici
- `/unarchive ses_ed2c` → id'yi önekle çözer ve doğrudan uyandırır
- Yaşayan bir konuda `/unarchive` → bu oturumun arşivde olmadığını bildirir

**Notlar**:
- Idsiz tahmin etmen gerekmez: seçici arşivlenmiş olanları butonlarla listeler (başlık · proje · etkinlik), 8'lik sayfalar halinde.
- `<metin>`, **projeye** (klasör adı), başlığa ya da id önekine göre arama olarak işe yarar.
- Id tam ya da tekil önek olarak kabul edilir, büyük/küçük fark etmez.
- Konu silinmişse, geçerli başlıkla yenisi oluşturulur.
- Gizli sohbette `/archive` konuyu siler, bu yüzden `/unarchive` onu yeniden oluşturur; PC'deki oturuma asla dokunulmaz.

### /delthread

**Ne işe yarar**: Forum konusunu siler ama oturuma dokunmaz.

**Kullanım**: `/delthread` ya da `/delthread <ses_id>`

**Örnekler**:
- Bir konuda `/delthread` → konu kaybolur

**Notlar**: Oturum var olmaya devam eder — bir sonraki olayı konusunu yeniden oluşturur. Onu susturmak için: `/archive`. Id tekil bir önek kabul eder, büyük/küçük fark etmez.

### /rebuild

**Ne işe yarar**: TÜM oturum konularını siler ve forumu temizce yeniden inşa eder.

**Kullanım**: `/rebuild` (satır içi onayla)

**Örnekler**:
- `/rebuild` → eşleştirilmiş konuları siler (teker teker, onaylayarak) ve son zamanlarda kullandıklarınınkileri yeniden oluşturur (12'ye kadar, en yeni üstte)

**Notlar**: Eski mesajlar yeniden içe aktarılmaz — `/export` her oturumun transkriptini indirir. Konular yalnızca son `rebuildIdleHours` (varsayılan 24 saat) içinde kullanılan oturumlar için yeniden oluşturulur: sunucu yeniden başlatmada tüm oturumların `updated` alanının üzerine yazar, dolayısıyla ona göre sıralamak günlerdir kimseye dokunulmamış oturumları diriltiyordu; `idle` gerçek son etkinliktir. Her silme, eşleştirme unutulmadan önce onaylanır — Telegram biri reddederse (hız sınırı, kopma), konu eşleştirilmiş kalır ve bir sonraki `/rebuild` tekrar dener; konusu hayatta kalan bir oturum çoğaltılmaz. **Yetim** konular (eşleştirmesiz) kendi başlarına temizlenemez: Bot API'de "konuları listele" yoktur, bu yüzden bir kez elle silinmelidir.

## Dosya ve kod

### /ls

**Ne işe yarar**: Oturum projesinin dosyalarında gezinir.

**Kullanım**: `/ls [klasör]`

**Örnekler**:
- `/ls` → projenin kök dizinini listeler
- `/ls src` → src klasörüne girer
- Bir dosyaya dokun → onu indirir
- Metin dosyasında 📎 → onu bir sonraki mesaja ekler

**Notlar**: Butonların dizinleri sona erer — bir dokunuş "liste eski" derse `/ls`'i tekrar aç.

### /find

**Ne işe yarar**: Ada göre bulanık dosya arama.

**Kullanım**: `/find <metin>`

**Örnekler**:
- `/find navbar` → adında "navbar" geçen dosyalar
- `/find .test.` → adında ".test." geçen dosyalar

**Notlar**: Oturumun tüm projesinde arar.

### /git

**Ne işe yarar**: Ajanın projede neye dokunduğu — `+/−` ile durum ve indirilebilir diff.

**Kullanım**: `/git`

**Örnekler**:
- `/git` → projenin durumu
- "Diff'i gör" → önizleme + indirilebilir `.patch`

**Notlar**: Bu projenin diff'idir, oturumun değil — birkaç ajan paylaşabilir.

### /revert

**Ne işe yarar**: Bir oturumun son turunu geri alır (onayla).

**Kullanım**: `/revert` ya da `/revert <ses_id>`

**Örnekler**:
- Bir konuda `/revert` → son turu geri almayı önerir
- Butonla onaylarsın → tur geri alınır

**Notlar**: Yalnızca son turu geri alır. Birkaçı için: `/revert` tekrarlanır.

### /export

**Ne işe yarar**: Bir oturumun tam transkriptini JSON olarak indirir.

**Kullanım**: `/export` ya da `/export <ses_id>`

**Örnekler**:
- Bir konuda `/export` → transkript JSON'u sana gelir
- `/export ses_xxx` → her yerden aynı şey

**Notlar**: Oturum PC'de açıkken dışa aktarım tamamdır. Kapalıyken diskte transkript olmayabilir (sunucunun süreklilik hatası).

### /sh

**Ne işe yarar**: Bir kabuk komutunu oturumun İÇİNDE çalıştırır — arka planda, ajanı uyandırmadan.

**Kullanım**: `/sh <komut>`

**Örnekler**:
- `/sh node -v` → `v24.21.0`
- `/sh git status` → deponun durumu
- `/sh ls` → dizinin içeriği

**Notlar**: Oturumun kabuğu PowerShell'dir — `&&` çalışmaz, `;` kullan. Çıktı konuya gelir.

**Korumalı komutlar**: komut **ayrıştırılır** (regex ile aranmaz: gerçek adlar, takma adlar çözülerek) ve üç düzeyden birine düşer:

- **Doğrudan geçer**: salt okuma (`Get-*`, `Test-*`, `ls`, `cat`) ve geliştirme araç takımı (`git`, `node`, `npm`, `cargo`, `python`...). Burada bir yanlış pozitif, botu her `git status` öncesinde onay isteyecek hale getirirdi.
- **Onay ister**: geri alınabilir ama hizmeti kesebilen ya da makineden çıkabilen şeyler — sunucuyu yeniden başlatmak, süreç öldürmek, yazılım kurmak, ağ çağrıları, uzaktan yürütme, zamanlanmış görevler. Kart **her komutun ne yaptığını açıklar** (ne olacağı, yalnızca metin değil) ve "Onayla ve çalıştır"'a dokunulmalıdır. Bekleyen, yürütmeye **önce** kaldırılır, böylece bir çökme onu yeniden tetiklemez.
- **Engellenir, istisnasız**: geri dönüşü olmayan — disk biçimlendirme ve silme, önyükleme ve sistem kurtarma, kayıt defteri, kullanıcılar ve kimlik bilgileri, sırlar (`.env`, `.ssh`, tarayıcı profilleri, `Env:` sürücüsü), savunmalar (antivirüs, güvenlik duvarı, BitLocker), günlük silme ve tüm kaçış vektörleri (`iex`, `Invoke-Command`, iç içe `powershell`/`cmd`, `-EncodedCommand`, `Add-Type`, doğrudan .NET/COM erişimi, işlev ve takma ad tanımlama). Onaylansa bile yürütülmez: onun için PC'nin konsolu var.

Silme **yolla sınırlıdır**: `Remove-Item` (ve `rm`, `del`, `rmdir`...) proje klasörü içinde izinlidir — kod yazan bir ajan `node_modules`'u silebilmeli — ve dışında engellenir. Tüm projeyi (`.`) ya da `.git`'i silmek onay ister.

**Neden** (2026-10-07 olayı): `/sh opencode service restart`, eklentiyi barındıran süreci öldürdü; poll offset'i yalnızca bellekte olduğundan Telegram her yeniden başlatmada update'i yeniden gönderdi ve sunucu, eklenti elle kapatılana dek ~10 sn'lik bir döngüye girdi. Kalıcı offset çare; bu koruma önlemdir.

### /note

**Ne işe yarar**: Transkripte bir not bırak — ajan onu bir sonraki turda okur, şu an uyandırılmaz.

**Kullanım**: `/note <metin>`

**Örnekler**:
- `/note Satış modülüne öncelik ver` → ajan onu bağlam olarak görür

**Notlar**: Bu sentetik bir mesajdır — ajanı çalıştırmaz.

### /turns

**Ne işe yarar**: Oturumun turlarının neyi değiştirdiği — `/git`'ten daha ince.

**Kullanım**: `/turns` ya da `/turns <ses_id>`

**Örnekler**:
- Bir konuda `/turns` → turların değişiklikleri

**Notlar**: Sunucu tur değişimi kaydetmediyse boş olabilir.

## Proje ve config

### /config

**Ne işe yarar**: Projenin `opencode.jsonc`'ini okur ve düzenler — yeni oturumların varsayılan modeli.

**Kullanım**: `/config` ya da `/config model <sağlayıcı/model>`

**Örnekler**:
- `/config` → geçerli config'i gösterir
- `/config model nvidia/z-ai/glm-5.3` → varsayılanı değiştirir (canlı yeniden yükler)

**Notlar**: Değişiklik YENİ oturumlar için geçerlidir — sunucuyu yeniden başlatmak gerekmez.

### /worktree

**Ne işe yarar**: Projenin worktree'lerini listeler ya da yenisini oluşturur.

**Kullanım**: `/worktree` ya da `/worktree new <ad>`

**Örnekler**:
- `/worktree` → her worktree'de oturum açan butonlarla liste
- `/worktree new feature-x` → worktree'yi oluşturur

**Notlar**: Bir worktree'de oturum açmak için ona dokun.

### /move

**Ne işe yarar**: Bir oturumu başka bir projeye taşır.

**Kullanım**: `/move <dizin>`

**Örnekler**:
- `/move E:\Projects\Baska` → konudaki oturum o projeye taşınır

**Notlar**: Telegram konusu aynı kalır — yalnızca çalışma dizini değişir.

### /mcp

**Ne işe yarar**: MCP sunucularını listeler ya da birini bağlar/koparır.

**Kullanım**: `/mcp` ya da `/mcp connect|disconnect <server>`

**Örnekler**:
- `/mcp` → durumla liste (🟢 bağlı / 🔴 değil)
- `/mcp disconnect abap-docs` → koparır
- `/mcp connect abap-docs` → yeniden bağlar

**Notlar**: Yeni sunucu eklemek (PUT) PC'ye kalır.

### /commands

**Ne işe yarar**: Config'teki özel komutları listeler ya da birini çalıştırır.

**Kullanım**: `/commands` ya da `/commands run <metin>`

**Örnekler**:
- `/commands` → liste (init, review vb.)
- `/commands run init` → "init" komutunu konunun oturumunda çalıştırır

**Notlar**: Özel komutlar projenin `opencode.jsonc`'inde tanımlanır.

## Bilgi ve hata ayıklama

### /locale

**Ne işe yarar**: Bot'un dilini değiştirir — `/help` menüsü, kartlar ve tüm mesajlar anında takip eder.

**Kullanım**: `/locale` (butonlarla) ya da `/locale <es|en|pt|de|fr|it|id|ru|tr|zh>`

**Örnekler**:
- `/locale` → dil başına bir buton içeren kart (geçerli olan ✓ ile)
- `/locale tr` → doğrudan değiştirir; onay seçilen dilde gelir

**Notlar**: Seçim `~/.opencode/tg/locale.txt`'de kalıcıdır — yeniden başlatma onu kaybetmez. `.env`'deki `TG_LOCALE` yalnızca başlangıç değeridir. Yeni bir dil, `CATALOGS`'te (src/locale.ts) yeni bir nesne artık kendi `COMMANDS.<dil>.md`'sidir — başka kod gerekmez.

### /bots

**Ne işe yarar**: Çoklu-botDağılımını gösterir: hangi bot hangi proje ya da oturumu aynalıyor, kim boşta ve gerisini kapsayan ana bot (hub).

**Kullanım**: `/bots`

**Örnekler**:
- `/bots` → bot başına bir satır — talebiyle (proje, oturum ya da "boş") ve etkin topolojiyle

**Notlar**: Ek botlar `~/.opencode/tg/.env`'de `TELEGRAM_BOT_TOKEN_<AD>` olarak bildirilir — asla repoda. Topoloji (`single` / `per-project` / `per-session`) ve açık eşleme (`assign`) `config.json`'daki `"bots"` bloğunda yaşar. Tek botla, kart nasıl biri ekleneceğini açıklar. Her ek bot, ana bot gibi BotFather'da topics etkin olmasını ister.

### /release

**Ne işe yarar**: BU bot'u havuza geri verir — yalnızca `per-session` topolojisinde. Onun oturumu, bir başkası talep edene dek hub'a gider.

**Kullanım**: `/release` (serbest bırakmak istediğin bot'un sohbetinden)

**Örnekler**:
- `/release` → "🧹 serbest bırakıldı — onun oturumu hub'a döner"

**Notlar**: Bot, onu talep eden oturumu arşivlediğinde (`/archive`) kendiliğinden de döner. `single` ve `per-project`'te komut, geçerli olmadığını yanıtlar. Oturum yeniden etkinleştiğinde, bir sonraki turu otomatik olarak boş bir bot talep eder.

### /context

**Ne işe yarar**: Bir oturumun tokenları, maliyeti, model sınırı ve sıkıştırmaları.

**Kullanım**: `/context` ya da `/context <ses_id>`

**Örnekler**:
- Bir konuda `/context` → bu oturumun bağlam kullanımı

**Notlar**: Sunucu yükü taşımıyorsa model transkriptten geri kazanılır.

### /usage

**Ne işe yarar**: Bir oturumun tokenları ve maliyeti — sağlayıcı ve modelle.

**Kullanım**: `/usage` ya da `/usage <ses_id>`

**Örnekler**:
- Bir konuda `/usage` → `🧪 nvidia · z-ai/glm-5.3 · ajan build` + tokenler

**Notlar**: Sunucu yükü unuttuğunda model ve ajan transkriptten geri kazanılır.

### /history

**Ne işe yarar**: Bir oturumun sohbetinin sonu.

**Kullanım**: `/history` ya da `/history <ses_id>`

**Örnekler**:
- Bir konuda `/history` → son 16 mesaj

**Notlar**: Sunucudan (etkin oturum) ya da diskteki transkriptten okur.

### /log

**Ne işe yarar**: Oturumun sunucu tarafı günlüğünden bir kesit.

**Kullanım**: `/log` ya da `/log <ses_id>`

**Örnekler**:
- Bir konuda `/log` → günlüğün son 10 olayı

**Notlar**: Bu bir okuma penceresidir — tam günlük değildir.

### /ci

**Ne işe yarar**: Deponun son GitHub Actions çalıştırmalarını gösterir — hangi iş akışı, hangi commit üzerinde ve yeşil ya da kırmızı. Bir push'un bütünüyle ulaştığını kanıtlayan şey: typecheck, test setleri ve haftada iki kez bağımlılık mührü.

**Kullanım**: `/ci`, `/ci <n>` ya da `/ci <iş-akışı>`

**Örnekler**:
- `/ci` → durumlarıyla son 6 çalıştırma ve sha'ya bir link
- `/ci 12` → son 12
- `/ci deps` → yalnızca `deps-audit` iş akışının çalıştırmaları

**Notlar**: GitHub REST API'sini bağımlılıksız okur. Depo herkese açık, bu yüzden tokensuz çalışır (IP başına saatte 60 istek); `~/.opencode/tg/.env`'de bir `GITHUB_TOKEN` limiti yükseltir ve özel depolara ulaşır. Varsayılan depo `par4987/opencode-tg`'dir — bir fork, `config.json`'da `"ci": { "repo": "owner/repo" }` ya da `TG_CI_REPO` ile değiştirir.

### /terminal

**Ne işe yarar**: Oturumun terminali, yalnızca okuma.

**Kullanım**: `/terminal` ya da `/terminal <ses_id>`

**Örnekler**:
- Bir konuda `/terminal` → terminalin son satırları

**Notlar**: Ajan etkileşimli bir şey çalıştırdığında belirir. Kontrol PC'de kalır.

### /perms

**Ne işe yarar**: Kaydedilmiş "her zaman" izinlerini listeler ya da birini geri çeker.

**Kullanım**: `/perms` ya da `/perms del <id>`

**Örnekler**:
- `/perms` → birikmiş "🔁 Her zaman"
- `/perms del psv_xxx` → birini geri çeker

**Notlar**: Geri çekmek sunucuyu tekrar sormaya iter.

### /sessions

**Ne işe yarar**: Sunucunun bildiği oturumlar.

**Kullanım**: `/sessions`

**Örnekler**:
- `/sessions` → durumuyla liste (🎯 etkin, 📡 ayna, 💤 idle)

### /running

**Ne işe yarar**: Şu an bir turu çalıştıran oturumlar.

**Kullanım**: `/running`

**Örnekler**:
- `/running` → şu an ne çalışıyor

### /models

**Ne işe yarar**: Oturumun modelini değiştirir — sayfalanan seçiciyle.

**Kullanım**: `/models` ya da `/models <metin>`

**Örnekler**:
- `/models` → sağlayıcılar ve modellerle seçici
- `/models glm` → "glm"e göre süzer

**Notlar**: Yalnızca masaüstünün etkinleştirdiği ya da config'in bildirdiği modeller.

### /agents

**Ne işe yarar**: Oturumun ajanını değiştirir.

**Kullanım**: `/agents` ya da `/agent`

**Örnekler**:
- `/agents` → ajan seçici

### /projects

**Ne işe yarar**: Yeni oturum açmak için projeleri listeler.

**Kullanım**: `/projects`

**Örnekler**:
- `/projects` → proje seçici

### /tasks

**Ne işe yarar**: Bot'un zamanlanmış görevlerini listeler.

**Kullanım**: `/tasks`

**Örnekler**:
- `/tasks` → bir sonraki çalıştırmalarıyla görevler

### /newtask

**Ne işe yarar**: 6 adımlı bir sihirbazla zamanlanmış görev oluşturur.

**Kullanım**: `/newtask`

**Örnekler**:
- `/newtask` → sihirbaz: ad, prompt, proje, model, zamanlama, ayrıntı

### /skills

**Ne işe yarar**: Kurulu yetenekleri listeler ve birini bir sonraki mesaja hazırlar.

**Kullanım**: `/skills` ya da `/skill <id> <metin>`

**Örnekler**:
- `/skills` → yetenek seçici
- Birine dokun → promptu yaz

## Sohbet ve kuyruk

### /queue

**Ne işe yarar**: Oturumun Gelen Kutusundaki bekleyen mesajlar.

**Kullanım**: `/queue` ya da `/queue <ses_id>`

**Örnekler**:
- `/queue` → yeniden sırala (↑↓), öne al (▶), iptal (✖), değiştir (✏️) ile liste

**Notlar**: Sıkıştırma ve taşıma öğeleri zaten etiketlidir.

### /flush

**Ne işe yarar**: Gelen Kutusunun tuttuğu her şeyi geçerli tura taşır.

**Kullanım**: `/flush` ya da `/flush <metin>`

**Örnekler**:
- `/flush` → Gelen Kutusunu tura boşaltır
- `/flush X yap` → metni tura HEMEN enjekte eder

**Notlar**: Metinle doğrudan yönlendirmedir — geçerli tura girer.

### /clearqueue

**Ne işe yarar**: Gelen Kutusundaki tüm bekleyen mesajları iptal eder.

**Kullanım**: `/clearqueue` ya da `/clearqueue <ses_id>`

**Örnekler**:
- `/clearqueue` → tümünü iptal eder

### /send

**Ne işe yarar**: Bir oturuma her yerden prompt gönderir.

**Kullanım**: `/send <metin>` ya da `/send <ses_id> <metin>`

**Örnekler**:
- `/send bir özet yap` → konunun oturumuna gider
- `/send ses_xxx X yap` → o oturuma gider

### /txt

**Ne işe yarar**: Ajanın açık sorusuna serbest cevap.

**Kullanım**: `/txt <cevap>`

**Örnekler**:
- `/txt B seçeneği` → etkin soruyu cevaplar

### /menu

**Ne işe yarar**: Butonlarla komut menüsü.

**Kullanım**: `/menu`

**Örnekler**:
- `/menu` → ana komutlarla klavye

### /help

**Ne işe yarar**: Her birinin ayrıntısını görmek için menüyle komutları listeler.

**Kullanım**: `/help`

**Örnekler**:
- `/help` → kısa liste + klavye
- Bir komuta dokun → ayrıntılı bölümü (ne işe yarar, kullanım, örnekler, notlar)

### /watch

**Ne işe yarar**: Sohbette hangi oturumların izlendiğini kontrol eder.

**Kullanım**: `/watch <id|all|off>`

**Örnekler**:
- `/watch all` → her şeyi izle
- `/watch ses_xxx` → yalnızca onu izle
- `/watch off` → hiçbir şeyi izleme

**Notlar**: Config'te `mirror: all` iken `/watch <id>`, diğerlerini susturur.
