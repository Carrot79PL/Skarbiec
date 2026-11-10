# Skarbiec – instrukcja

Autor: Tomasz Marchewka. Wersja i autor są widoczne na ekranie blokady, w „Kopia i ustawienia” → O programie oraz w menu Skarbiec → O programie (macOS).

Desktopowa aplikacja do przechowywania kont pocztowych: imię, nazwisko, e-mail, hasło (oraz kolejne hasła), licencje,
dane kontaktowe i organizacyjne (nazwa wyświetlana, dział, stanowisko, telefony, biuro), własne pola i uwagi.
Dane są szyfrowane hasłem głównym (AES-256-GCM). Od wersji 1.7.0 klucz z hasła powstaje algorytmem **scrypt**
(od 1.8.1: N = 2²⁰, r = 8, p = 2 – ok. 1 GB pamięci i ok. 7 s na każdą próbę; 1.8.0: p = 1, 1.7.0: N = 2¹⁷),
co wielokrotnie utrudnia łamanie hasła na kartach graficznych. Wyższe N (2²¹ i więcej) nie jest możliwe – mechanizm
szyfrowania w Electronie zamyka wtedy program. Odblokowanie trwa przez to ok. 7 s (Apple M2); podczas odszyfrowywania widać pasek postępu.
Skarbiec i kopie zapasowe z wcześniejszych wersji (PBKDF2-SHA256, 310 000 iteracji) otwierają się normalnie i po pierwszym
odblokowaniu są automatycznie przepisywane na scrypt z aktualnymi parametrami. Kopie zapasowe zapisane w 1.7.0 i nowszych otworzy tylko wersja 1.7.0+.
Najważniejsze dla bezpieczeństwa jest długie hasło główne, najlepiej 4–5 losowych słów albo co najmniej 14 znaków.

## Gdzie są dane
Windows: `%APPDATA%\Skarbiec\vault.json` (obok: `vault.json.bak` – poprzednia wersja).
macOS: `~/Library/Application Support/Skarbiec/vault.json`.
Do wersji 1.4.x program nazywał się „Skarbiec kont Office”. Wersja 1.5.0 przy pierwszym uruchomieniu kopiuje skarbiec ze starego folderu
(`Skarbiec kont Office`); stary folder zostaje nietknięty jako zapas i można go później usunąć.
Plik jest zaszyfrowany. Bez hasła głównego nie da się go odczytać.

## Import z Excela
Rozpoznawane kolumny (nazwy mogą być po polsku lub angielsku): Imię, Nazwisko, E-mail, Hasło, Licencja, Uwagi.
Obsługiwany jest też eksport użytkowników z centrum administracyjnego Microsoft 365 (CSV: Display name, First name,
Last name, User principal name, Licenses). Konta bez hasła mogą dostać hasło wygenerowane automatycznie.

## Uruchomienie ze źródeł
Wymagany Node.js 20 lub nowszy.

    npm install
    npm start

## Budowanie
    npm run dist:win    # instalator .exe i wersja przenośna (w folderze dist)
    npm run dist:mac    # .dmg i .zip dla Apple Silicon (arm64) i Intel (x64), w folderze dist
    npm run dist:mac:arm64   # tylko Apple Silicon
    npm run dist:mac:x64     # tylko Intel

Budowanie na Macu odbywa się w katalogu tymczasowym (skrypt build-mac.sh), bo foldery synchronizowane
(Pulpit/Dokumenty w iCloud, OneDrive) dodają atrybuty Findera, które psują podpis aplikacji.

## macOS
- Aplikacja jest podpisana ad-hoc (bez certyfikatu Apple Developer). Przy pierwszym uruchomieniu macOS ją zablokuje:
  kliknij ikonę prawym przyciskiem → Otwórz, albo Ustawienia systemowe → Prywatność i ochrona → „Otwórz mimo to”.
  Alternatywnie w Terminalu: `xattr -dr com.apple.quarantine "/Applications/Skarbiec.app"`.
- Wymagany macOS 11 Big Sur lub nowszy.
- Natywne menu po polsku: ⌘N nowe konto, ⌘F szukaj, ⌘L zablokuj, ⌘, ustawienia, ⇧⌘I import, ⇧⌘E eksport.
- W liście ⌘⌫ usuwa zaznaczone konto.
- Skarbiec blokuje się sam przy uśpieniu Maca i zablokowaniu ekranu (także na Windows).
- Zamknięcie okna kończy program (celowo — skarbiec nie zostaje otwarty w tle).

## Skróty
Ctrl+N (⌘N) nowe konto, Ctrl+F (⌘F) szukaj, Ctrl+L (⌘L) zablokuj, strzałki w liście, Enter edycja, Delete (⌘⌫) usunięcie.

## Zaznaczanie wielu kont
- ⌘-klik (Ctrl+klik) dodaje lub usuwa konto z zaznaczenia, Shift+klik i Shift+strzałki zaznaczają zakres.
- ⌘A (Ctrl+A) zaznacza wszystkie widoczne konta (z uwzględnieniem wyszukiwania i filtra licencji).
- Przycisk „Zaznacz” nad listą włącza pola wyboru; Esc lub „Gotowe” kończy zaznaczanie.
- Dla zaznaczonych kont: „Usuń zaznaczone” (także ⌘⌫ / Delete) i „Eksportuj zaznaczone”.
- Po usunięciu przez kilka sekund widać przycisk „Cofnij”.

## Wyszukiwanie
- Szuka po wszystkich danych: imię, nazwisko, e-mail, licencje, dział, stanowisko, telefony, biuro, własne pola, uwagi.
- Nie trzeba wpisywać polskich znaków („gestwicki” znajdzie „Gęstwicki”), wielkość liter nie ma znaczenia.
- Kilka słów zawęża wynik („adrian bia”), numer telefonu można wpisać bez spacji („600100”).
- Wystarczy zacząć pisać — tekst trafia do wyszukiwarki. Enter lub ↓ przechodzi do wyników, Esc czyści pole.
- Trafienia są podświetlone; gdy pasuje inne pole niż nazwisko lub e-mail, widać je pod adresem.

## Import bez haseł i z dodatkowymi danymi
- Hasło nie jest wymagane — konta bez hasła są importowane (opcjonalnie można im wygenerować hasła).
- Nagłówek tabeli nie musi być w pierwszym wierszu (np. tytuł nad tabelą), a przy kilku arkuszach można wybrać właściwy.
- Kilka licencji w jednej komórce, oddzielonych przecinkami, jest rozpoznawane osobno; „Brak licencji” → „Bez licencji”.
- Pozostałe kolumny można zaimportować jako własne pola konta.
- Konta, które już są w skarbcu, można tylko uzupełnić (puste pola) albo nadpisać danymi z pliku.
- Obsługiwane są też pliki zapisane przez narzędzia .NET/OpenXML (ścieżki bezwzględne i prefiks `x:` w XML),
  których standardowa biblioteka nie odczytuje.

## Kolejne hasła
- W edytorze „+ Dodaj kolejne hasło” dodaje hasło z opisem (np. VPN, PIN, stare hasło) — bez limitu.
- „Nowe hasło” zapisuje dotychczasowe hasło jako „Poprzednie hasło”.
- Eksport do Excela zapisuje je w kolumnach „Hasło 2”, „Opis hasła 2”, „Hasło 3”… (ponowny import je odczyta).

## Uzupełnianie danych wielu kont
Zaznacz konta (np. ⌘A) i wybierz „Uzupełnij dane…”: ustaw dział, stanowisko, telefon, biuro lub własne pole,
dodaj albo usuń licencję, dopisz uwagę — domyślnie tylko tam, gdzie pole jest puste.

## Wysyłanie hasła SMS-em
Opcja „Wyślij hasło SMS…” w szczegółach konta jest aktywna dopiero po podłączeniu numeru firmowego
w „Kopia i ustawienia” → „SMS z numeru firmowego”. Dwa sposoby:
- **iPhone z numerem firmowym** (bez opłat): SMS wychodzi przez aplikację Wiadomości na Macu. Wymaga tego samego Apple ID
  na iPhonie i Macu oraz włączonego na iPhonie: Ustawienia → Aplikacje → Wiadomości → Przekazywanie wiadomości tekstowych → ten Mac.
  Przy pierwszym użyciu macOS zapyta o zgodę na sterowanie Wiadomościami (Prywatność i ochrona → Automatyzacja).
- **Bramka SMSAPI.pl**: token API z panelu SMSAPI, opcjonalnie zatwierdzona nazwa nadawcy.

Numer, token i treść szablonu są zapisane w skarbcu zaszyfrowane hasłem głównym (także w kopii zapasowej).
Szablon obsługuje {imię}, {nazwisko}, {email}, {hasło}, {opis}; można wybrać, które hasło wysłać (główne lub kolejne).
Numer odbiorcy brany jest z pola „Telefon komórkowy” lub „Telefon”; jeśli konto go nie miało, wpisany numer zostaje zapisany.

## Synchronizacja z Microsoft 365
„Kopia i ustawienia” → „Microsoft 365 – konto administratora” → „Podłącz…” → „Zaloguj się w Microsoft 365”.
Otwiera się strona Microsoftu, wpisujesz pokazany kod (jest już w schowku) i logujesz się kontem administratora.
Przy pierwszym logowaniu zaznacz „Wyraź zgodę w imieniu organizacji”.

- Synchronizacja działa w jedną stronę: program tylko **odczytuje** użytkowników, dane kontaktowe i licencje (uprawnienia User.Read.All,
  Organization.Read.All, wyłącznie zapytania GET). Jedyny wyjątek to opcjonalna zmiana haseł (niżej): włączana osobno
  i wykonywana tylko na Twoje polecenie.
- Automatycznie po odblokowaniu skarbca i co 15 minut; ręcznie przyciskiem „Microsoft 365 · godzina” w panelu bocznym.
- Microsoft 365 jest źródłem imion, nazwisk, działu, stanowiska, telefonów, biura i licencji. Hasła, kolejne hasła,
  uwagi i własne pola zostają tylko w skarbcu i nie są nadpisywane. Puste pole w M365 nie kasuje danych w skarbcu.
- Nowi użytkownicy pojawiają się automatycznie (bez hasła). Goście (#EXT#) są pomijani; konta z zablokowanym logowaniem
  (np. skrzynki współdzielone) – domyślnie też.
- Konta usunięte w M365 nie są kasowane ze skarbca – trafiają do filtra „Brak w Microsoft 365”.
- Domyślnie używana jest aplikacja Microsoftu „Microsoft Graph Command Line Tools”; można podać własną rejestrację z Entra ID
  (przepływy klienta publicznego włączone, delegowane User.Read.All i Organization.Read.All ze zgodą administratora).
- Dostęp (token odświeżania) jest zapisany w skarbcu, zaszyfrowany hasłem głównym.
- Haseł nie da się pobrać z Microsoft 365 (Microsoft przechowuje tylko ich skróty). Program odczytuje natomiast datę
  ostatniej zmiany hasła: jeśli hasło zmieniono w M365 później niż zapisano je w skarbcu, konto trafia do filtra
  „Hasło do sprawdzenia” z ostrzeżeniem i przyciskami „Wpisz aktualne hasło” / „Hasło jest aktualne”.

## Filtry
- W panelu bocznym: „Konta imienne” to konta konkretnych osób z imieniem i nazwiskiem. Nie ma tu skrzynek wspólnych
  ani usługowych, np. biuro@, faktury@ czy skaner@.
- Przycisk lejka obok wyszukiwarki pokazuje filtry, które można łączyć: rodzaj konta, licencja, dział, stanowisko i biuro.
  Liczby w nawiasach mówią, ile kont zostanie po wybraniu wartości. „(nie wpisano)” oznacza puste pole.
- Filtry łączą się z wyborem w panelu bocznym i z wyszukiwarką. „Zaznacz wszystkie” zaznacza tylko widoczne konta.

## Zmiana haseł wielu kont (generator i Microsoft 365)
Zaznacz konta (np. filtr „Konta imienne” → ⌘A) → „Zmień hasła…”. Przy jednym koncie powiązanym z M365 to samo okno
otwiera przycisk „Nowe hasło”.
- Generator: długość 12–32 znaki, rodzaje znaków (min. 3 z 4, zgodnie z wymogiem Microsoft 365), bez podobnych znaków
  (0/O, 1/l/I). Każde konto dostaje inne, losowe hasło, a dotychczasowe trafia do „Poprzednie hasło”.
- „Zmień też w Microsoft 365”: nowe hasło jest ustawiane od razu w M365 (Microsoft Graph, PATCH /users/{id},
  tylko passwordProfile). Opcjonalnie możesz wymusić zmianę hasła przy następnym logowaniu.
- Zmianę haseł w M365 włączasz osobno: „Kopia i ustawienia” → Microsoft 365 → „Zmiana haseł w Microsoft 365” → „Włącz…”.
  Wymaga to ponownego zalogowania i zgody na uprawnienie User-PasswordProfile.ReadWrite.All. Konto musi mieć rolę
  administratora globalnego albo administratora uwierzytelniania uprzywilejowanego (do zmiany haseł innych administratorów).
- Pomijane są: konta niepowiązane z M365, konta usunięte w M365 i konto administratora podłączone do Skarbca.
  Błędy, np. brak uprawnień do konta innego administratora, są pokazane przy danym koncie. Ponowne kliknięcie
  „Zmień hasła” spróbuje jeszcze raz tylko tam, gdzie się nie udało.
- Skarbiec zapisuje się po każdym zmienionym koncie, więc nowe hasło nie zginie, nawet jeśli operacja zostanie przerwana.
  „Zatrzymaj” przerywa zmianę po bieżącym koncie.
- Po zakończeniu „Eksportuj nowe hasła…” zapisuje zmienione konta do Excela, np. żeby rozdać hasła. Plik zawiera hasła
  jawnym tekstem.
- Bez podłączonego M365 (albo z wyłączoną opcją) hasła zmieniają się tylko w Skarbcu.

## Ochrona przed podglądem
- **Blokada zrzutów i udostępniania ekranu** (domyślnie włączona; „Kopia i ustawienia” → Bezpieczeństwo): okno Skarbca jest czarne
  na zrzutach ekranu, nagraniach i podczas udostępniania ekranu (Teams, Zoom, Meet). Ekran blokady jest chroniony zawsze.
  Na macOS sprawdzone zrzutem systemowym; zachowanie konkretnego komunikatora warto raz sprawdzić, udostępniając ekran.
- **Schowek**: na macOS skopiowane hasła są oznaczone jako poufne (menedżery schowka ich nie zapisują) i nie trafiają do schowka
  uniwersalnego na iPhone/iPada. Schowek czyści się po ustawionym czasie (15 s – 90 s).
- **Pokazane hasło** ukrywa się samo po 10 s – 1 min (do ustawienia).
- **Autoblokada** po 1–30 min bezczynności, opcjonalnie także po zminimalizowaniu lub ukryciu okna; zawsze przy uśpieniu
  komputera i blokadzie ekranu.
- **Nieudane próby odblokowania**: od trzeciej rosnąca przerwa (15 s, 30 s, 60 s… do 5 min). Liczba nieudanych prób trafia do dziennika.
- W zainstalowanej aplikacji nie da się otworzyć narzędzi deweloperskich.

## Bezpieczeństwo haseł
W panelu bocznym sekcja „Bezpieczeństwo haseł” z filtrami: hasła z wycieków, słabe, powtórzone (to samo hasło na kilku kontach),
stare (domyślnie ponad 180 dni od ustawienia w skarbcu) i konta bez hasła. Problemy konkretnego konta widać też w jego szczegółach
z przyciskiem „Zmień hasło…”. „Raport” (⇧⌘B) pokazuje wynik ogólny, liczby i:
- **sprawdzenie wycieków** w bazie Have I Been Pwned metodą k-anonimowości: z komputera wychodzi tylko 5 pierwszych znaków skrótu SHA-1
  hasła; wynik jest zapisany w skarbcu, a hasła zmienione później są pomijane do następnego sprawdzenia;
- **wykorzystanie licencji** Microsoft 365 (przypisane / kupione, wolne lub brakujące) z ostatniej synchronizacji.

## Dziennik zdarzeń
⇧⌘D albo „Raport” → „Dziennik zdarzeń…”. Zapisuje: odblokowania (z liczbą wcześniejszych nieudanych prób), blokady z przyczyną,
wyświetlenia i skopiowania haseł, dodanie, zmiany i usunięcie kont, zmiany haseł (w tym w Microsoft 365), SMS-y, eksporty, importy,
kopie zapasowe, karty dostępu, zmiany ustawień bezpieczeństwa. Dziennik jest zaszyfrowany razem ze skarbcem (ostatnie 3000 zdarzeń),
ma wyszukiwarkę i eksport do Excela.

## Karta dostępu
„Karta dostępu…” w szczegółach konta albo „Karty dostępu…” dla zaznaczonych kont: strona A4 na osobę z loginem, hasłem (opcjonalnie),
licencjami, krótką instrukcją logowania i zmiany hasła oraz miejscem na podpisy. Druk albo zapis do PDF (plik z hasłem po przekazaniu usuń).

## Aplikacje i strony

Oprócz konta Microsoft 365 każde konto może mieć dowolną liczbę dostępów do innych aplikacji i stron: Facebook, Instagram, inna poczta, Asana, Magento, Ergonode, LinkedIn, Google Ads, WordPress i dowolne własne. Każdy dostęp ma nazwę, adres strony, login, hasło i uwagi. Dostępy wybiera się osobno dla każdej osoby.

- **Dodawanie** – w edytorze konta (sekcja „Aplikacje i strony”, szybkie przyciski popularnych aplikacji) albo w szczegółach konta („+ Facebook”, „+ Inna…”). Adres strony podpowiada się z listy, a dla aplikacji firmowych (np. panel Magento) z innego konta, na którym już go wpisano. Aplikacja dopisana raz (np. Adobe) pojawia się od razu wśród przycisków szybkiego dodawania u kolejnych osób – najczęściej używane są pierwsze.
- **Wiele osób naraz** – zaznacz konta → „Dodaj dostęp do aplikacji…”. Login: adres e-mail albo część przed @. Hasło: osobne, wygenerowane dla każdej osoby albo do uzupełnienia później.
- **Filtrowanie** – w panelu bocznym sekcja „Aplikacje i strony” (kto ma dostęp do np. Asany) oraz filtr „Aplikacja” na pasku filtrów; wyszukiwarka szuka też po nazwach aplikacji i loginach.
- **Bezpieczeństwo** – hasła aplikacji są oceniane tak jak hasła Microsoft 365 (słabe, powtórzone – także między aplikacjami tej samej osoby – stare, z wycieków).
- **Karta dostępu, SMS, eksport** – karta może zawierać tabelę dostępów do aplikacji; SMS pozwala wysłać hasło aplikacji (pola {aplikacja} i {login}); eksport do Excela dodaje arkusz „Aplikacje”, a import go rozpoznaje (kolumny E-mail, Aplikacja, Login, Hasło, Adres strony, Uwagi).
- Przycisk „Otwórz” uruchamia stronę aplikacji w przeglądarce (tylko adresy http/https).

## Kolejność sekcji
Sekcje w szczegółach konta (Logowanie i hasła, Licencje, Dane użytkownika, Uwagi) można przeciągać za nagłówek
albo przesuwać strzałkami; ustawienie jest też w „Kopia i ustawienia”. Pola własne o nazwie wskazującej na hasło/PIN
(„Stare hasło”, „PIN”…) są pokazywane w kropkach, a takie kolumny w imporcie trafiają do kolejnych haseł.
