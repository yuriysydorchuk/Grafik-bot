// Мапа «місто станції → воєводство» для аналітики пального. Покриває міста,
// що реально трапляються у фактурах Orlen (+ великі міста про запас); нове
// незнайоме місто повертає null → у UI летить в «Інше». Неоднозначні назви
// (кілька сіл-тезок) розвʼязані на користь маршрутів наших команд.
const CITY_WOJ: Record<string, string> = {
  // lubelskie
  "lublin": "Lubelskie", "świdnik": "Lubelskie", "jastków": "Lubelskie",
  "piotrowice": "Lubelskie", "ryki": "Lubelskie", "żyrzyn": "Lubelskie",
  "leokadiów": "Lubelskie", "sobieszczany - kolonia": "Lubelskie",
  "puławy": "Lubelskie", "kraśnik": "Lubelskie", "chełm": "Lubelskie", "zamość": "Lubelskie",
  // wielkopolskie
  "poznań": "Wielkopolskie", "luboń": "Wielkopolskie", "kórnik": "Wielkopolskie",
  "przeźmierowo": "Wielkopolskie", "tulce": "Wielkopolskie", "suchy las": "Wielkopolskie",
  "krzyżowniki": "Wielkopolskie", "sierakowo": "Wielkopolskie", "kalisz": "Wielkopolskie",
  "konin": "Wielkopolskie", "leszno": "Wielkopolskie", "gniezno": "Wielkopolskie",
  // łódzkie
  "łódź": "Łódzkie", "ozorków": "Łódzkie", "zgierz": "Łódzkie",
  "parzęczew": "Łódzkie", "stryków": "Łódzkie", "piotrków trybunalski": "Łódzkie",
  // mazowieckie
  "warszawa": "Mazowieckie", "tarczyn": "Mazowieckie", "baranów": "Mazowieckie",
  "wola korycka górna": "Mazowieckie", "kołbiel": "Mazowieckie", "łochów": "Mazowieckie",
  "radom": "Mazowieckie", "płock": "Mazowieckie",
  // śląskie
  "gliwice": "Śląskie", "zabrze": "Śląskie", "bytom": "Śląskie", "katowice": "Śląskie",
  "chorzów": "Śląskie", "aleksandrowice": "Śląskie", "częstochowa": "Śląskie",
  // podlaskie
  "białystok": "Podlaskie", "porosły": "Podlaskie",
  // pomorskie
  "gdańsk": "Pomorskie", "gdynia": "Pomorskie", "kleszczewko": "Pomorskie",
  // małopolskie
  "kraków": "Małopolskie", "sucha beskidzka": "Małopolskie",
  // świętokrzyskie
  "końskie": "Świętokrzyskie", "kielce": "Świętokrzyskie",
  // warmińsko-mazurskie
  "olsztynek": "Warmińsko-Mazurskie", "olsztyn": "Warmińsko-Mazurskie",
  // podkarpackie
  "orły": "Podkarpackie", "krzemienica": "Podkarpackie", "rzeszów": "Podkarpackie",
  "przemyśl": "Podkarpackie",
};

export function wojewodztwoOf(city: string | null | undefined): string | null {
  if (!city) return null;
  return CITY_WOJ[city.trim().toLowerCase()] ?? null;
}
