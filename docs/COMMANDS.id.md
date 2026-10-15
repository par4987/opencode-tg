# Panduan perintah

Setiap perintah dengan apa fungsinya, cara dipakai, contoh, dan catatan. Menu
`/help` di Telegram menyediakan perintah yang sama — ketuk satu dan kamu
menerima bagiannya.

## Sesi

### /new

**Apa fungsinya**: Membuat sesi baru di proyek yang kamu pilih, dengan thread Telegram-nya dibuka seketika.

**Penggunaan**: `/new <judul?>`

**Contoh**:
- `/new Analisis penjualan` → menampilkan pemilih proyek; mengetuk satu membuat sesi "Analisis penjualan" di sana
- `/new` → menanyakan judul di chat dan, setelah diberikan, menampilkan pemilih

**Catatan**:
- Proyek percakapan aktif datang pertama di pemilih (✅) — itu default-nya: sekali ketuk jadi.
- "➕ Proyek baru…" menanyakan nama dan membuat folder itu di sebelah proyek aktif; sesi dibuka di dalamnya.
- Thread dibuka saat membuat (dulu lahir dengan pesan pertama): tulis di dalamnya dan sesinya sudah mendengarkan.
- Kamu memilih provider dan model di thread baru: terbuka pada provider model default proyek, dengan model itu ditandai ✅ — sekali ketuk mempertahankannya, atau jelajahi yang lain. Sama setelahnya dengan `/models`.
- Kalau `/new` dikirim tanpa judul, pesan berikutnya yang ditulis di thread itu dalam 10 menit menjadi namanya.

### /use

**Apa fungsinya**: Menentukan sesi mana yang menjadi tujuan pesan dari akar chat.

**Penggunaan**: `/use <ses_id>`

**Contoh**:
- `/use ses_f2a05826affeXDqtDAtfF23Rud` → akar menunjuk ke sesi itu
- `/use` → menampilkan sesi aktif

**Catatan**: Pesan dalam sebuah thread selalu menuju sesi thread itu, terlepas dari `/use`.

### /fork

**Apa fungsinya**: Membagi sesi sampai pesan terakhirnya — cobalah ide tanpa mengotori yang asli.

**Penggunaan**: `/fork` (di thread) atau `/fork <ses_id>`

**Contoh**:
- `/fork` di thread sebuah sesi → membuat fork dan memberitahumu
- `/fork ses_xxx` → sama dari mana saja

**Catatan**: Fork adalah sesi baru dengan thread-nya sendiri. Yang asli tetap utuh.

### /rename

**Apa fungsinya**: Mengganti nama sesi — thread Telegram dan desktop mengikuti perubahannya.

**Penggunaan**: `/rename <judul>` atau `/rename <ses_id> <judul>`

**Contoh**:
- `/rename Analisis Q4` → mengganti nama sesi dari thread itu
- `/rename` (tanpa judul) → menyarankan 3 judul dari transkrip dan kamu pilih dengan satu ketukan

**Catatan**: Judul dipotong pada 128 karakter (batas nama topik Telegram).

### /detach

**Apa fungsinya**: Melepaskan akar chat dari sesinya — apa yang kamu tulis di sana tidak lagi menuju sesi mana pun.

**Penggunaan**: `/detach`

**Contoh**:
- `/detach` → akar menjadi bebas
- `/use <ses_id>` → menghubungkan kembali

**Catatan**: Thread sesi tidak terpengaruh.

### /archive

**Apa fungsinya**: Mengarsipkan sesi dari thread — di chat pribadi menghapus thread dan membisukan sesi.

**Penggunaan**: `/archive` atau `/archive <ses_id>`

**Contoh**:
- `/archive` dalam sebuah thread → thread menghilang dari chat
- `/archive ses_xxx` → sama dari mana saja (id menerima prefiks unik)

**Catatan**: `/unarchive` mengembalikannya — sendirian membuka pemilih yang terarsip, jadi id tidak diperlukan.

### /unarchive

**Apa fungsinya**: Membangunkan sesi terarsip — tanpa id membuka pemilih; dengan teks mencari berdasarkan proyek, judul, atau id.

**Penggunaan**: `/unarchive`, `/unarchive <teks>` atau `/unarchive <ses_id>`

**Contoh**:
- `/unarchive` di akar → membuka pemilih dengan sesi terarsip, yang terbaru lebih dulu
- `/unarchive faktur` → pemilih dengan yang cocok (judul, proyek, atau id)
- `/unarchive ses_ed2c` → menyelesaikan id berdasarkan prefiks dan membangunkannya langsung
- `/unarchive` di thread yang hidup → memberitahu bahwa sesi itu tidak terarsip

**Catatan**:
- Tanpa id tidak perlu menebak: pemilih mendaftar yang terarsip dengan tombol (judul · proyek · aktivitas), dalam halaman 8 butir.
- `<teks>` berfungsi sebagai pencarian berdasarkan **proyek** (nama folder), judul, atau prefiks id.
- Id diterima utuh atau sebagai prefiks unik, tanpa membedakan huruf besar.
- Kalau thread telah dihapus, dibuat yang baru dengan judul aktif.
- Di chat pribadi `/archive` menghapus thread, jadi `/unarchive` membuatnya ulang; sesi di PC tidak pernah disentuh.

### /delthread

**Apa fungsinya**: Menghapus thread forum tanpa menyentuh sesinya.

**Penggunaan**: `/delthread` atau `/delthread <ses_id>`

**Contoh**:
- `/delthread` dalam sebuah thread → thread menghilang

**Catatan**: Sesi tetap ada — peristiwa berikutnya membuat threadnya lagi. Untuk membisukannya: `/archive`. Id menerima prefiks unik, tanpa membedakan huruf besar.

### /rebuild

**Apa fungsinya**: Menghapus SEMUA thread sesi dan membangun ulang forum yang bersih.

**Penggunaan**: `/rebuild` (dengan konfirmasi inline)

**Contoh**:
- `/rebuild` → menghapus thread terpetakan (satu per satu, dikonfirmasi) dan membuat ulang milik sesi yang kamu pakai belakangan (hingga 12, yang terbaru di atas)

**Catatan**: Pesan lama tidak diimpor ulang — `/export` mengunduh transkrip tiap sesi. Thread dibuat ulang hanya untuk sesi yang dipakai dalam `rebuildIdleHours` terakhir (default 24 jam): server menimpa field `updated` semua sesi saat restart, jadi mengurutkannya membangkitkan sesi yang tidak disentuh siapa pun selama berhari-hari; `idle` adalah aktivitas terakhir yang nyata. Setiap penghapusan dikonfirmasi sebelum mapping dilupakan — kalau Telegram menolak satu (rate limit, terputus), thread tetap terpetakan dan `/rebuild` berikutnya mencoba lagi; sesi yang thread-nya selamat tidak diduplikasi. Thread **yatim** (tanpa mapping) tidak bisa dibersihkan sendiri: Bot API tidak punya "daftar topik", jadi harus dihapus dengan tangan satu kali saja.

## File dan kode

### /ls

**Apa fungsinya**: Menavigasi file proyek sesi.

**Penggunaan**: `/ls [folder]`

**Contoh**:
- `/ls` → mendaftar direktori akar proyek
- `/ls src` → masuk ke folder src
- Ketuk sebuah file → mengunduhnya
- 📎 pada file teks → melampirkannya ke pesan berikutnya

**Catatan**: Indeks tombol kedaluwarsa — kalau ketukan bilang "listing lama", buka `/ls` lagi.

### /find

**Apa fungsinya**: Pencarian fuzzy file berdasarkan nama.

**Penggunaan**: `/find <teks>`

**Contoh**:
- `/find navbar` → file yang namanya mengandung "navbar"
- `/find .test.` → file dengan ".test." pada namanya

**Catatan**: Mencari di seluruh proyek sesi.

### /git

**Apa fungsinya**: Apa yang disentuh agen di proyek — status dengan `+/−` dan diff yang dapat diunduh.

**Penggunaan**: `/git`

**Contoh**:
- `/git` → status proyek
- "Lihat diff" → pratinjau + `.patch` yang dapat diunduh

**Catatan**: Ini diff proyek, bukan sesi — beberapa agen bisa membaginya.

### /revert

**Apa fungsinya**: Membatalkan turn terakhir sesi (dengan konfirmasi).

**Penggunaan**: `/revert` atau `/revert <ses_id>`

**Contoh**:
- `/revert` dalam sebuah thread → mengusulkan membatalkan turn terakhir
- Kamu mengonfirmasi dengan tombol → turn dibatalkan

**Catatan**: Hanya membatalkan turn terakhir. Untuk beberapa: `/revert` diulang.

### /export

**Apa fungsinya**: Mengunduh transkrip lengkap sesi sebagai JSON.

**Penggunaan**: `/export` atau `/export <ses_id>`

**Contoh**:
- `/export` dalam sebuah thread → JSON transkrip sampai ke kamu
- `/export ses_xxx` → sama dari mana saja

**Catatan**: Dengan sesi terbuka di PC, export lengkap. Ditutup, bisa jadi tidak ada transkrip di disk (bug persistensi server).

### /sh

**Apa fungsinya**: Menjalankan perintah shell DI DALAM sesi — di latar belakang, tanpa membangunkan agen.

**Penggunaan**: `/sh <perintah>`

**Contoh**:
- `/sh node -v` → `v24.21.0`
- `/sh git status` → status repo
- `/sh ls` → isi direktori

**Catatan**: Shell sesi adalah PowerShell — `&&` tidak berfungsi, pakai `;`. Outputnya tiba di thread.

**Perintah terlindungi**: perintah **diurai** (bukan dicari dengan regex: nama aslinya, dengan alias diselesaikan) dan jatuh ke salah satu dari tiga tingkat:

- **Lewat langsung**: baca murni (`Get-*`, `Test-*`, `ls`, `cat`) dan toolchain pengembangan (`git`, `node`, `npm`, `cargo`, `python`...). False positive di sini membuat bot meminta konfirmasi sebelum setiap `git status`.
- **Meminta konfirmasi**: yang dapat dipulihkan tapi bisa memutus layanan atau keluar dari mesin — merestart server, membunuh proses, memasang perangkat lunak, panggilan jaringan, eksekusi jarak jauh, tugas terjadwal. Kartu **menjelaskan apa yang dilakukan setiap perintah** (apa yang akan terjadi, bukan sekadar teksnya) dan "Konfirmasi dan jalankan" harus diketuk. Yang tertunda dihapus **sebelum** eksekusi, jadi crash tidak memicunya lagi.
- **Diblokir, tanpa pengecualian**: yang tidak ada jalan kembali — format dan penghapusan disk, boot dan pemulihan sistem, registri, pengguna dan kredensial, rahasia (`.env`, `.ssh`, profil peramban, drive `Env:`), pertahanan (antivirus, firewall, BitLocker), penghapusan log, dan semua vektor evasi (`iex`, `Invoke-Command`, `powershell`/`cmd` bersarang, `-EncodedCommand`, `Add-Type`, akses langsung .NET/COM, pendefinisian fungsi dan alias). Meski dikonfirmasi tidak dijalankan: untuk itu ada konsol PC.

Penghapusan **dibatasi per path**: `Remove-Item` (dan `rm`, `del`, `rmdir`...) diizinkan di dalam folder proyek — agen yang menulis kode harus bisa menghapus `node_modules` — dan diblokir di luarnya. Menghapus seluruh proyek (`.`) atau `.git` meminta konfirmasi.

**Mengapa** (insiden 2026-10-07): `/sh opencode service restart` membunuh proses yang meng-hosting plugin; karena offset poll hanya ada di memori, Telegram mengirim ulang update di setiap restart dan server masuk ke loop ~10 detik sampai plugin dimatikan dengan tangan. Offset persisten adalah obatnya; guard ini pencegahannya.

### /note

**Apa fungsinya**: Meninggalkan catatan di transkrip — agen membacanya di turn berikutnya, tanpa dibangunkan sekarang.

**Penggunaan**: `/note <teks>`

**Contoh**:
- `/note Prioritaskan modul penjualan` → agen melihatnya sebagai konteks

**Catatan**: Ini pesan sintetis — tidak menjalankan agen.

### /turns

**Apa fungsinya**: Apa yang diubah turn-turn sesi — lebih halus dari `/git`.

**Penggunaan**: `/turns` atau `/turns <ses_id>`

**Contoh**:
- `/turns` dalam sebuah thread → perubahan dari turn-turn

**Catatan**: Bisa kosong kalau server tidak mencatat perubahan turn.

## Proyek dan config

### /config

**Apa fungsinya**: Membaca dan mengedit `opencode.jsonc` proyek — model default sesi baru.

**Penggunaan**: `/config` atau `/config model <provider/model>`

**Contoh**:
- `/config` → menampilkan config aktif
- `/config model nvidia/z-ai/glm-5.3` → mengganti default (dimuat ulang langsung)

**Catatan**: Perubahan berlaku untuk sesi BARU — tidak perlu merestart server.

### /worktree

**Apa fungsinya**: Mendaftar worktree proyek atau membuat yang baru.

**Penggunaan**: `/worktree` atau `/worktree new <nama>`

**Contoh**:
- `/worktree` → daftar dengan tombol yang membuka sesi di tiap worktree
- `/worktree new feature-x` → membuat worktree

**Catatan**: Ketuk sebuah worktree untuk membuka sesi di sana.

### /move

**Apa fungsinya**: Memindahkan sesi ke proyek lain.

**Penggunaan**: `/move <direktori>`

**Contoh**:
- `/move E:\Projects\Lain` → sesi dari thread dipindahkan ke proyek itu

**Catatan**: Thread Telegram tetap sama — hanya direktori kerja yang berubah.

### /mcp

**Apa fungsinya**: Mendaftar server MCP atau menghubungkan/memutuskan satu.

**Penggunaan**: `/mcp` atau `/mcp connect|disconnect <server>`

**Contoh**:
- `/mcp` → daftar dengan status (🟢 terhubung / 🔴 tidak)
- `/mcp disconnect abap-docs` → memutusnya
- `/mcp connect abap-docs` → menghubungkannya lagi

**Catatan**: Menambah server baru (PUT) tetap urusan PC.

### /commands

**Apa fungsinya**: Mendaftar perintah kustom config atau menjalankan satu.

**Penggunaan**: `/commands` atau `/commands run <teks>`

**Contoh**:
- `/commands` → daftar (init, review, dsb.)
- `/commands run init` → menjalankan perintah "init" di sesi thread

**Catatan**: Perintah kustom didefinisikan di `opencode.jsonc` proyek.

## Info dan debug

### /locale

**Apa fungsinya**: Mengganti bahasa bot — menu `/help`, kartu, dan semua pesan mengikuti seketika.

**Penggunaan**: `/locale` (dengan tombol) atau `/locale <es|en|pt|de|fr|it|id|ru|tr|zh|ko>`

**Contoh**:
- `/locale` → kartu dengan satu tombol per bahasa (yang aktif dengan ✓)
- `/locale id` → mengganti langsung; konfirmasi datang Dalam bahasa yang dipilih

**Catatan**: Pilihan tersimpan di `~/.opencode/tg/locale.txt` — restart tidak menghilangkannya. `TG_LOCALE` di `.env` hanya nilai awal. Bahasa baru adalah objek baru di `CATALOGS` (src/locale.ts) plus `COMMANDS.<bahasa>.md`-nya — tanpa kode tambahan.

### /bots

**Apa fungsinya**: Menampilkan distribusi multi-bot: bot mana memirror proyek atau sesi mana, siapa yang bebas, dan bot utama (hub) yang mencakup sisanya.

**Penggunaan**: `/bots`

**Contoh**:
- `/bots` → satu baris per bot dengan klaimnya (proyek, sesi, atau "bebas") dan topologi aktif

**Catatan**: Bot tambahan dideklarasikan sebagai `TELEGRAM_BOT_TOKEN_<NAMA>` di `~/.opencode/tg/.env` — tidak pernah di repo. Topologi (`single` / `per-project` / `per-session`) dan mapping eksplisit (`assign`) ada di blok `"bots"` `config.json`. Dengan satu bot, kartu menjelaskan cara menambah yang lain. Tiap bot tambahan butuh topics diaktifkan di BotFather, sama seperti bot utama.

### /release

**Apa fungsinya**: Mengembalikan bot INI ke pool — hanya di topologi `per-session`. Sisinya menuju hub sampai ada yang mengklaimnya.

**Penggunaan**: `/release` (dari chat bot yang kamu ingin bebaskan)

**Contoh**:
- `/release` → "🧹 dilepaskan — sesinya kembali ke hub"

**Catatan**: Bot juga kembali sendiri saat kamu mengarsipkan (`/archive`) sesi yang mengklaimnya. Di `single` dan `per-project` perintah menjawab bahwa tidak berlaku. Saat sesi diaktifkan lagi, turn berikutnya mengklaim bot bebas secara otomatis.

### /context

**Apa fungsinya**: Token, biaya, batas model, dan kompaksi sebuah sesi.

**Penggunaan**: `/context` atau `/context <ses_id>`

**Contoh**:
- `/context` dalam sebuah thread → penggunaan konteks sesi itu

**Catatan**: Model diambil dari transkrip kalau payload server tidak membawanya.

### /usage

**Apa fungsinya**: Token dan biaya sebuah sesi, dengan provider dan model.

**Penggunaan**: `/usage` atau `/usage <ses_id>`

**Contoh**:
- `/usage` dalam sebuah thread → `🧪 nvidia · z-ai/glm-5.3 · agen build` + token

**Catatan**: Model dan agen diambil dari transkrip saat payload melupakannya.

### /history

**Apa fungsinya**: Akhir percakapan sebuah sesi.

**Penggunaan**: `/history` atau `/history <ses_id>`

**Contoh**:
- `/history` dalam sebuah thread → 16 pesan terakhir

**Catatan**: Membaca dari server (sesi aktif) atau transkrip di disk.

### /log

**Apa fungsinya**: Cuplikan log sisi server dari sesi.

**Penggunaan**: `/log` atau `/log <ses_id>`

**Contoh**:
- `/log` dalam sebuah thread → 10 peristiwa terakhir dari log

**Catatan**: Ini jendela baca — bukan log lengkap.

### /ci

**Apa fungsinya**: Menampilkan eksekusi GitHub Actions terbaru repo — workflow mana, pada commit mana, dan hijau atau merah. Yang membuktikan push tiba utuh: typecheck, suite, dan dua kali seminggu, segel dependensi.

**Penggunaan**: `/ci`, `/ci <n>` atau `/ci <workflow>`

**Contoh**:
- `/ci` → 6 eksekusi terakhir dengan statusnya dan link ke sha
- `/ci 12` → 12 terakhir
- `/ci deps` → hanya eksekusi workflow `deps-audit`

**Catatan**: Membaca API REST GitHub tanpa dependensi. Repo-nya publik, jadi berfungsi tanpa token (60 permintaan/jam per IP); `GITHUB_TOKEN` di `~/.opencode/tg/.env` menaikkan batas dan menjangkau repo privat. Repo default `par4987/opencode-tg` — fork mengubahnya dengan `"ci": { "repo": "owner/repo" }` di `config.json` atau `TG_CI_REPO`.

### /terminal

**Apa fungsinya**: Terminal sesi, hanya baca.

**Penggunaan**: `/terminal` atau `/terminal <ses_id>`

**Contoh**:
- `/terminal` dalam sebuah thread → baris-baris terakhir terminal

**Catatan**: Muncul saat agen menjalankan sesuatu yang interaktif. Kontrol tetap di PC.

### /perms

**Apa fungsinya**: Mendaftar izin "selalu" yang tersimpan atau mencabut satu.

**Penggunaan**: `/perms` atau `/perms del <id>`

**Contoh**:
- `/perms` → "🔁 Selalu" yang terkumpul
- `/perms del psv_xxx` → mencabut satu

**Catatan**: Mencabut membuat server bertanya lagi.

### /sessions

**Apa fungsinya**: Sesi-sesi yang dikenal server.

**Penggunaan**: `/sessions`

**Contoh**:
- `/sessions` → daftar dengan status (🎯 aktif, 📡 mirror, 💤 idle)

### /running

**Apa fungsinya**: Sesi dengan turn yang sedang berjalan.

**Penggunaan**: `/running`

**Contoh**:
- `/running` → apa yang sedang bekerja

### /models

**Apa fungsinya**: Mengganti model sesi — dengan pemilih berhalaman.

**Penggunaan**: `/models` atau `/models <teks>`

**Contoh**:
- `/models` → pemilih dengan provider dan model
- `/models glm` → menyaring "glm"

**Catatan**: Hanya model yang diaktifkan desktop atau dideklarasikan config.

### /agents

**Apa fungsinya**: Mengganti agen sesi.

**Penggunaan**: `/agents` atau `/agent`

**Contoh**:
- `/agents` → pemilih agen

### /projects

**Apa fungsinya**: Mendaftar proyek untuk membuka sesi baru.

**Penggunaan**: `/projects`

**Contoh**:
- `/projects` → pemilih proyek

### /tasks

**Apa fungsinya**: Mendaftar tugas terjadwal bot.

**Penggunaan**: `/tasks`

**Contoh**:
- `/tasks` → tugas dengan eksekusi berikutnya

### /newtask

**Apa fungsinya**: Membuat tugas terjadwal dengan wizard 6 langkah.

**Penggunaan**: `/newtask`

**Contoh**:
- `/newtask` → wizard: nama, prompt, proyek, model, jadwal, detail

### /skills

**Apa fungsinya**: Mendaftar skill terpasang dan menyiapkan satu untuk pesan berikutnya.

**Penggunaan**: `/skills` atau `/skill <id> <teks>`

**Contoh**:
- `/skills` → pemilih skill
- Ketuk satu → tulis promptnya

## Chat dan antrian

### /queue

**Apa fungsinya**: Pesan tertunda di kotak masuk sesi.

**Penggunaan**: `/queue` atau `/queue <ses_id>`

**Contoh**:
- `/queue` → daftar dengan urut ulang (↑↓), majukan (▶), batal (✖), ganti (✏️)

**Catatan**: Item kompaksi dan pemindahan sudah diberi label.

### /flush

**Apa fungsinya**: Memasukkan ke turn berjalan semua yang ditahan kotak masuk.

**Penggunaan**: `/flush` atau `/flush <teks>`

**Contoh**:
- `/flush` → mengosongkan kotak masuk ke turn
- `/flush lakukan X` → menyuntikkan teks ke turn SEKARANG

**Catatan**: Dengan teks itu steering langsung — masuk ke turn berjalan.

### /clearqueue

**Apa fungsinya**: Membatalkan semua pesan tertunda di kotak masuk.

**Penggunaan**: `/clearqueue` atau `/clearqueue <ses_id>`

**Contoh**:
- `/clearqueue` → membatalkan semua

### /send

**Apa fungsinya**: Mengirim prompt ke sesi dari mana saja.

**Penggunaan**: `/send <teks>` atau `/send <ses_id> <teks>`

**Contoh**:
- `/send buat ringkasan` → menuju sesi dari thread
- `/send ses_xxx lakukan X` → menuju sesi itu

### /txt

**Apa fungsinya**: Jawaban bebas untuk pertanyaan terbuka agen.

**Penggunaan**: `/txt <jawaban>`

**Contoh**:
- `/txt Opsi B` → menjawab pertanyaan aktif

### /menu

**Apa fungsinya**: Menu perintah dengan tombol.

**Penggunaan**: `/menu`

**Contoh**:
- `/menu` → papan ketik dengan perintah utama

### /help

**Apa fungsinya**: Mendaftar perintah dengan menu untuk melihat detail masing-masing.

**Penggunaan**: `/help`

**Contoh**:
- `/help` → daftar singkat + papan ketik
- Ketuk sebuah perintah → bagiannya secara rinci (apa fungsinya, penggunaan, contoh, catatan)

### /watch

**Apa fungsinya**: Mengontrol sesi mana yang dipantau di chat.

**Penggunaan**: `/watch <id|all|off>`

**Contoh**:
- `/watch all` → pantau semua
- `/watch ses_xxx` → pantau hanya itu
- `/watch off` → tidak memantau apa pun

**Catatan**: Dengan `mirror: all` di config, `/watch <id>` membisukan yang lain.
