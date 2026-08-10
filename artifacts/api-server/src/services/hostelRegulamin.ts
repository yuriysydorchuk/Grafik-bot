// Тексти правил проживання в хостелі (витягнуті з docx-майстрів папки водія:
// «Протоколы/Regulamin hostelu», знімок 31.07.2026). Мова мешканця → текст;
// невідома мова → польська. Надсилається ботом при заселенні (POST /hostels/stays).
export const HOSTEL_REGULAMIN: Record<string, string> = {
  pl: `ZASADY POBYTU W HOSTELU
Witamy w naszym hostelu i staramy się zrobić wszystko, aby Państwa pobyt był jak najbardziej komfortowy i pozostawił tylko miłe wspomnienia. Jednak w tym celu należy przestrzegać pewnych zasad. Przestrzegając tych zasad i obowiązków, razem możemy osiągnąć spokój, porządek w hostelu i wzajemny szacunek.
W hostelu zabrania się:
wprowadzania osób trzecich do hostelu w godzinach nocnych, przekazywania kluczy do pokoju do zamieszkania;
przestawiania mebli w pokojach i pomieszczeniach ogólnodostępnych;
trzymania zwierząt i ptaków;
spożywania napojów alkoholowych i niskoalkoholowych we wszystkich pomieszczeniach hostelu, przebywania w stanie nietrzeźwości alkoholowej lub narkotykowej;
Koordynator hostelu zastrzega sobie prawo do przedterminowego zakończenia pobytu i eksmisji osoby w przypadku jej przebywania w stanie nietrzeźwości alkoholowej, narkotykowej lub innego rodzaju, lub w przypadku innych naruszeń zasad pobytu w hostelu i/lub porządku publicznego, bez zwrotu środków pieniężnych. Może również nałożyć grzywnę w wysokości 1000 zł.
hałasowania i zakłócania spokoju innych mieszkańców w godzinach od 22:00 do 8:00;
palenia we wszystkich pomieszczeniach, z wyjątkiem miejsc do tego przeznaczonych (oznakowanych tabliczkami). Za palenie w niedozwolonych miejscach w hostelu pobierana jest grzywna w wysokości 500 zł.
kategorycznie zabrania się siedzenie, leżenie lub kładzenia rzeczy na sąsiednich łóżkach. W przypadku naruszenia tej zasady, będziemy zmuszeni pobrać  miesięczną opłatę za korzystanie z dodatkowego miejsca noclegowego;
zakłócania spokoju mieszkańców w pokoju i w innych pokojach hostelu;
przynoszenia i przechowywania broni, materiałów wybuchowych i łatwopalnych, toksycznych, żrących, trujących substancji narkotycznych i materiałów, broni palnej oraz innych przedmiotów niebezpiecznych dla życia i zdrowia obywateli;
Mieszkaniec hostelu jest zobowiązany:
przestrzegać ustalonych w hostelu zasad pobytu;
przestrzegać czystości w pokojach mieszkalnych i pomieszczeniach ogólnodostępnych – kuchni, pokoju wypoczynkowym, łazienkach itp. (przeprowadzać generalne sprzątanie raz w tygodniu);
ściśle przestrzegać zasad bezpieczeństwa przeciwpożarowego;
wyłączać oświetlenie główne po godzinie 23:00;
utrzymywać porządek w kuchni, myć za sobą naczynia;
podczas zakwaterowania w pokoju wieloosobowym, korzystać tylko z łóżka, za które zapłaciłeś;
dbać o mienie i wyposażenie hostelu;
zwrócić otrzymane klucze przed wyjazdem;
prawidłowo segregować śmieci;
z szacunkiem odnosić się do mieszkańców hostelu, nie używać wulgaryzmów w stosunku do kogokolwiek w hostelu;
Podczas zakwaterowania w hostelu, mieszkaniec otrzymuje czyste miejsce (łóżko lub cały pokój) z czystym materacem, kołdrą i poduszką. Podczas wymeldowania każdy mieszkaniec jest również zobowiązany do pozostawienia po sobie czystego miejsca. W przypadku, gdy mieszkaniec pozostawia po sobie zabrudzone miejsce (łóżko lub cały pokój), pomalowane lub uszkodzone ściany, podczas wymeldowania jest zobowiązany do zapłaty odszkodowania w wysokości od 200 do 1000 zł, w zależności od wyrządzonej szkody.
Hostel nie ponosi odpowiedzialności za przechowywanie pieniędzy i wartościowych przedmiotów pozostawionych bez nadzoru na terenie hostelu (w tym w pokoju). Wychodząc z pokoju, należy zamknąć drzwi na klucz.
W przypadku znalezienia rzeczy pozostawionych przez gości, podejmowane są działania mające na celu ich zwrot właścicielom. Jeśli właściciel nie zostanie znaleziony, rzeczy te przechowywane są przez 5 dni kalendarzowych. Po upływie okresu przechowywania, rzeczy są utylizowane. Koordynator ma prawo obciążyć właściciela kosztami przechowywania i/lub wysyłki rzeczy pozostawionych.
Hostel nie ponosi odpowiedzialności za funkcjonowanie miejskich instalacji (awaryjne wyłączenia prądu, wody, ogrzewania itp.).
W przypadku utraty lub uszkodzenia mienia hostelu, należy zrekompensować jego wartość.
Za celowe uszkodzenie mienia hostelu pobierana jest grzywna w wysokości od 500 zł, w zależności od uszkodzenia.
Imię i Nazwisko______________________________ Podpis_________________________________4650353608440`,
  uk: `ПРАВИЛА ПРОЖИВАННЯ У ХОСТЕЛІ
Ми вітаємо вас у нашому хостелі та намагаємося зробити все, щоб ваше перебування було максимально комфортним і залишило лише приємні враження. Але для цього необхідно дотримуватись певних правил. Дотримуючись цих правил і обов'язків, ми разом зможемо досягти спокою, порядку в хостелі та поваги один до одного.
У хостелі забороняється:
приводити в хостел сторонніх осіб у нічний час, передавати ключі від кімнати для проживання;
переставляти меблі в кімнатах та загальних приміщеннях;
тримати тварин і птахів;
вживати алкогольні та слабоалкогольні напої у всіх приміщеннях хостелу, перебувати в стані алкогольного або наркотичного сп’яніння;
Координатор хостелу залишає за собою право достроково припинити проживання і виселити особу у разі її перебування в стані алкогольного, наркотичного або іншого виду сп'яніння, або у разі інших порушень правил проживання у хостелі та/або громадського порядку без повернення грошових коштів. Також може накласти штраф у розмірі 1000 злотих.
шуміти та турбувати інших мешканців у період з 22:00 до 8:00;
палити в усіх приміщеннях, крім спеціально призначених для цього місць (позначених картками). За паління в недозволених місцях у хостелі стягується штраф у розмірі 500 злотих.
категорично забороняється сидіти, лежати або класти речі на сусідні ліжка. У разі порушення цього правила ми змушені будемо взяти з вас місячну оплату за використання додаткового місця;
порушувати спокій мешканців у кімнаті та в інших кімнатах хостелу;
приносити та зберігати зброю, вибухові та легкозаймисті, токсичні, їдкі, отруйні, наркотичні речовини та матеріали, вогнепальну зброю та інші небезпечні для життя та здоров'я громадян предмети;
Мешканець хостелу зобов'язаний:
дотримуватися встановлених у хостелі правил проживання;
дотримуватись чистоти в кімнатах для проживання та громадських приміщеннях – кухні, кімнаті відпочинку, санвузлах і т.п. (проводити генеральне прибирання раз на тиждень);
строго дотримуватися правил пожежної безпеки;
вимикати основне освітлення після 23:00;
підтримувати порядок на кухні, мити за собою посуд;
під час заселення в загальний номер використовуйте тільки те ліжко, за яке ви сплатили;
бережливо ставитися до майна та обладнання хостелу;
повернути перед виїздом отримані ключі;
правильно сортувати сміття;
з повагою ставитися до мешканців хостелу, не використовувати ненормативну лексику щодо будь-кого з мешканців хостелу;
Під час заселення в хостел мешканець отримує чисте місце (ліжко-місце або цілу кімнату) з чистим наматрасником, матрацом, ковдрою і подушкою. Під час виселення кожен мешканець також зобов'язаний залишити після себе чисте місце. У випадку, якщо мешканець залишає після себе забруднене місце (ліжко-місце або цілу кімнату), обмальовані або пошкоджені стіни, під час виселення він зобов'язаний сплатити компенсацію у розмірі від 200 до 1000 злотих залежно від завданої шкоди.
Хостел не несе відповідальності за збереження грошових коштів і цінних речей, залишених без нагляду на території хостелу (включаючи вашу кімнату). Виходячи з кімнати, закривайте двері на ключ.
У разі виявлення забутих речей вживаються заходи щодо їх повернення власникам. Якщо власника не знайдено, забуті речі зберігаються протягом 5 календарних днів. Після закінчення терміну зберігання речі утилізуються. Координатор має право перекласти витрати на зберігання забутих речей і/або їх пересилання на власника.
Хостел не несе відповідальності за роботу міських комунікацій (аварійне відключення світла, води, тепла тощо).
У разі втрати або пошкодження майна хостелу слід компенсувати його вартість.
За умисне пошкодження майна хостелу стягується штраф у розмірі від 500 зл, залежно від пошкодження.
Ім'я та Прізвище ______________________________ Підпис _________________________________
4650353608440`,
  ru: `РЕГЛАМЕНТ ПРОЖИВАНИЯ  В ХОСТЕЛЕ
Мы приветствуем вас в нашем хостеле и стараемся сделать всё, чтобы время пребывания стало максимально комфортным и оставило только хорошие впечатления. Но для этого, нужно соблюдать определенные правила. При соблюдении данных правил и обязанностей ,совместно, мы сможем добиться спокойствия, порядка в хостеле и уважения проживающих друг к другу.
В хостеле запрещается:
проводить в хостел посторонних лиц в ночное время, отдавать ключи от комнаты для проживания;
переставлять мебель в комнатах и общественных помещениях;
держать животных и птиц;
употреблять алкогольные и слабоалкогольные напитки во всех помещениях хостела, находиться в хостеле в состоянии алкогольного или наркотического опьянения; Координатор хостела оставляет за собой право досрочно прервать пребывание проживающего и выселить его в случае нахождения его в состоянии алкогольного, наркотического или иного вида опьянения или в случае иных нарушений правил проживания в хостеле и/или общественного порядка без возврата денежных средств. А так же выставить штраф в размере 1000 злотых.
шуметь и тревожить других проживающих в период c 22:00 до 8:00;
курить во всех помещениях, кроме специально предназначенных для этого мест (обозначенными карточками). За курение в хостеле, в непредназначенных местах взимается штраф в размере 500 злотых.
категорически запрещается сидеть, лежать, класть вещи на соседние кровати. В случае нарушения данного правила, мы будем вынуждены взять с Вас месячную оплату за использование дополнительного койко-места;
нарушать покой проживающих в комнате и в других комнатах хостела;
приносить и хранить оружие, взрывчатые и легковоспламеняющиеся, токсичные, едкие, ядовитые, наркотические вещества и материалы, огнестрельное оружие и иные, представляющие угрозу здоровью и жизни граждан, опасные предметы;
Проживающий в хостеле обязан:
соблюдать установленные в хостеле правила проживания;
соблюдать чистоту в комнатах для проживания, общественных помещениях – кухне, комнате отдыха в санузлах и т. п., (делать генеральную уборку раз в неделю)
строго соблюдать правила пожарной безопасности;
выключать основное освещение после 23:00;
поддерживать порядок на кухне, мыть за собой посуду;
при заселении в общий номер, используйте только ту кровать, за которую Вы оплатили;
беречь имущество и оборудование хостела;
вернуть перед отъездом полученные ключи;
правильно сортировать мусор;
беречь имущество и оборудование хостела;
с уважением относиться к проживающим в хостеле, не использовать ненормативную лексику в отношении любого проживающего в хостеле;
Проживающий при заселении в хостел , получает чистую (койка место или целую комнату) с чистым наматрасником , матрасом, одеялом и подушкой , при выселении каждый проживающий обязан также оставить после себя чистое  место. В случае, если проживающий  оставляет после себя загрязненные (койка место или целую комнату )обрисованные или потертые стены  при выселении , ему нужно будет заплатить компенсацию в размере от 200 до 1000 злотых в зависимости от причиненного ущерба.
Хостел, не несет ответственности за сохранность денежных средств и ценных вещей, оставленных без присмотра на территории хостела (в том числе и в вашей комнате). Покидая комнату, закрывайте дверь на ключ.
В случае обнаружения забытых вещей  принимаются меры к возврату их владельцам. Если владелец не найден,  забытые вещи хранятся в течение 5 календарных дней. После окончания срока хранения, вещи утилизируются. Координатор вправе возложить затраты по хранению забытых вещей и/или их пересылке владельцу на их владельца.
Хостел не несет ответственность за работу городских коммуникаций (аварийное отключение света, воды, тепла и пр.).
В случае утраты или повреждения имущества хостела, следует компенсировать их стоимость.
За умышленное повреждение имущества хостела взимается штраф в размере от 500 зл , в зависимости от повреждения.
Имя и Фамилия _____________________________________Подпись _________________________________
4650353608440`,
  en: `HOSTEL RULES
We welcome you to our hostel and strive to make your stay as comfortable as possible, leaving only pleasant impressions. However, to achieve this, it is necessary to adhere to certain rules. By following these rules and responsibilities, together we can achieve peace, order in the hostel, and mutual respect among residents.
It is prohibited in the hostel:
to bring outsiders into the hostel at night, hand over the room keys to others;
to rearrange furniture in rooms and common areas;
to keep animals and birds;
to consume alcoholic and low-alcohol beverages in all hostel premises, to be in the hostel in a state of alcohol or drug intoxication;
The hostel coordinator reserves the right to terminate a resident's stay and evict them in case of their being under the influence of alcohol, drugs, or any other intoxication, or in case of other violations of hostel rules and/or public order without a refund. A fine of 1000 PLN may also be imposed.
to make noise and disturb other residents from 22:00 to 8:00;
to smoke in all premises, except in specially designated areas (marked with signs). A fine of 500 PLN will be imposed for smoking in non-designated areas within the hostel.
It is strictly prohibited to sit, lie down, or place items on neighboring beds. In case of violation of this rule, we will be forced to charge you a monthly fee for the use of an additional bed;
to disturb the peace of the residents in the room and other rooms of the hostel;
to bring and store weapons, explosive and flammable, toxic, caustic, poisonous, narcotic substances and materials, firearms, and other items that pose a threat to the health and life of citizens;
A hostel resident is obliged:
to comply with the established hostel rules;
to maintain cleanliness in the living rooms and common areas – the kitchen, lounge, bathrooms, etc. (carry out general cleaning once a week);
to strictly follow fire safety rules;
to turn off the main lights after 23:00;
to keep the kitchen tidy, wash dishes after use;
to use only the bed you have paid for when settling in a shared room;
to take care of hostel property and equipment;
to return the keys before departure;
to properly sort waste;
to treat other hostel residents with respect, not to use foul language towards any hostel resident;
When checking into the hostel, a resident receives a clean space (bed or entire room) with a clean mattress cover, mattress, blanket, and pillow. Upon check-out, each resident is also obliged to leave their space clean. In case a resident leaves behind a dirty space (bed or entire room), or if walls are marked or scuffed, they will be required to pay compensation ranging from 200 to 1000 PLN depending on the damage.
The hostel is not responsible for the safety of money and valuables left unattended on the hostel premises (including in your room). When leaving the room, lock the door with a key.
In case forgotten items are found, efforts are made to return them to their owners. If the owner is not found, forgotten items are stored for 5 calendar days. After the storage period expires, the items are disposed of. The coordinator has the right to charge the costs of storing and/or shipping the forgotten items to the owner.
The hostel is not responsible for the functioning of city utilities (emergency power, water, heat outages, etc.).
In case of loss or damage to hostel property, its cost must be compensated.
For intentional damage to hostel property, a fine ranging from 500 PLN is imposed, depending on the damage.
Name and Surname______________________________ Signature_________________________________
4650353608440`,
};

export function regulaminFor(lang: string | null | undefined): string {
  const l = (lang ?? "").slice(0, 2).toLowerCase();
  return HOSTEL_REGULAMIN[l] ?? HOSTEL_REGULAMIN.pl!;
}
