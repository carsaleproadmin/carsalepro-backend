import type { VinHistorySectionCoverage, VinHistorySource } from './vin-history-payload-v2';
import type { VinHistoryReportSectionId } from './vin-history-report-model';

/**
 * Labels for the paid VIN history document, in the three locales the platform
 * actually serves (`User.locale`, `NotificationLocale`, `LegalLang` — all three
 * are de/en/ru today).
 *
 * Labels only. Every content rule — which sections exist, what an empty one
 * says, how money and dates are formatted, how a duration is derived — lives in
 * `vin-history-report-model.ts`, so a translation change can never alter what
 * the document asserts about a car.
 *
 * The dictionary is a total `Record` over the locale union and over every
 * section id — the seven a v1 document has, plus the seven contract v2 added: a
 * missing translation is a compile error, not a blank cell in a document
 * someone paid for, and never an English sentence inside a German PDF.
 *
 * NOTHING HERE MAY NAME A DATA SOURCE — not a company, not a registry, not the
 * territory one covers. Which suppliers stand behind the document is commercial
 * information; what a buyer is owed is the STATUS of each query (answered, not
 * reachable, not asked) and nothing more.
 *
 * The `synthetic` block is the one deliberate exception and stays fully
 * visible. Hiding WHO supplied data is a commercial choice; hiding that data was
 * GENERATED is a lie.
 */

export type VinHistoryPdfLocale = 'de' | 'en' | 'ru';

export const VIN_HISTORY_PDF_LOCALES: readonly VinHistoryPdfLocale[] = ['de', 'en', 'ru'] as const;

/** Matches the platform default (`User.locale` defaults to `de`). */
export const VIN_HISTORY_PDF_DEFAULT_LOCALE: VinHistoryPdfLocale = 'de';

/**
 * Narrow an arbitrary locale tag to one we have a document for.
 *
 * Accepts regional tags (`de-AT`, `ru-RU`) by taking the primary subtag: a
 * buyer whose profile says `de-CH` gets the German report, not the German
 * default via a silent miss.
 */
export function resolveVinHistoryPdfLocale(locale?: string | null): VinHistoryPdfLocale {
  if (!locale) return VIN_HISTORY_PDF_DEFAULT_LOCALE;
  const primary = locale.toLowerCase().split(/[-_]/)[0];
  return (VIN_HISTORY_PDF_LOCALES as readonly string[]).includes(primary)
    ? (primary as VinHistoryPdfLocale)
    : VIN_HISTORY_PDF_DEFAULT_LOCALE;
}

export interface VinHistorySectionStrings {
  title: string;
  /**
   * Printed INSTEAD of rows when the section is empty and the payload does not
   * say WHY it is empty. That is every v1 payload — v1 has no coverage map —
   * so this wording is frozen for those documents.
   */
  empty: string;
  /**
   * Printed instead when the payload says the source was queried and answered
   * (`coverage: 'covered'`). It is a finding about THIS car, so it is worded per
   * section rather than generically: "we checked and there is no damage" is
   * something the buyer paid to be told, and it must not read like a gap.
   */
  emptyCovered: string;
  columns: string[];
}

export interface VinHistoryPdfStrings {
  documentTitle: string;
  documentSubtitle: string;

  meta: {
    vin: string;
    /** ONE retrieval date exists in this document. See the report model. */
    retrievedAt: string;
    purchasedAt: string;
    renderedAt: string;
    purchaseId: string;
  };

  synthetic: {
    badge: string;
    title: string;
    body: string;
    /** Repeated on every page, because pages get separated. */
    footer: string;
  };

  highlights: {
    heading: string;
    records: string;
    owners: string;
    countries: string;
    lastMileage: string;
    firstRegistration: string;
    accidents: string;
    salvage: string;
    rollback: string;
    stolen: string;
    openRecalls: string;
    // v2 only. A v1 document has no data behind these and never prints them.
    titleBrands: string;
    /** Names taxi, police and rental in the label — the client asked for taxi by name. */
    commercialUse: string;
    insuranceTotalLoss: string;
  };

  /**
   * The opening block: which car this VIN decoded to.
   *
   * v2 only, and every field is optional in the payload because the decoder is
   * US-centric — a field it did not know is omitted from the block rather than
   * printed empty.
   *
   * There is no "decoded by" label: the decoder is a data source, and this
   * document names none.
   */
  vehicle: {
    title: string;
    make: string;
    model: string;
    modelYear: string;
    bodyClass: string;
    fuelType: string;
    transmission: string;
    drivetrain: string;
    enginePower: string;
    plantCountry: string;
  };

  /**
   * How many queries this report rests on, and how each one answered. v2 only.
   *
   * STATUS ONLY. Each entry is printed as a numbered position — `position` is
   * the word in front of that number — because a reader must be able to tell
   * "checked and empty" from "could not be reached", and must not be able to
   * tell which company was asked.
   *
   * The status wording is a total `Record` over `VinHistorySource['status']`, so
   * a new status added to the contract is a compile error here rather than a
   * blank cell in three languages.
   */
  sources: {
    title: string;
    note: string;
    columns: string[];
    /** Prefixes the position number: "Source 1", "Source 2". */
    position: string;
    empty: string;
    status: Record<VinHistorySource['status'], string>;
  };

  /**
   * Why an empty section is empty, when the payload says which.
   *
   * `covered` is deliberately absent: "we checked and found none" is a statement
   * about a specific category and lives per section (`emptyCovered`). These two
   * are statements about the SOURCE and read identically everywhere, so one
   * wording each is both enough and safer — a buyer must not have to guess
   * whether "nothing here" means the car is clean or the query failed.
   */
  coverageNotes: Record<Exclude<VinHistorySectionCoverage, 'covered'>, string>;

  /**
   * The line that closes the document.
   *
   * It says the report draws on several independent vehicle-data sources and
   * stops there. No count — a number invites "which ones" — and no superlative:
   * an unprovable "one of the three largest worldwide" is an actionable claim in
   * the German market, not marketing copy.
   */
  closingNote: string;

  /**
   * Row labels for the certificate-validity chapter.
   *
   * Generic on purpose. The national names of these tests (TÜV, STK, MOT) each
   * identify a territory and a body, and this document names neither.
   */
  inspectionValidity: {
    technical: string;
    emissions: string;
  };

  equipment: {
    standard: string;
    exteriorColors: string;
    interiorColors: string;
    warranty: string;
    msrp: string;
    invoice: string;
  };

  marketValue: {
    retail: string;
    tradeIn: string;
    msrp: string;
    asOf: string;
    /** A price without the mileage it was computed at is not a fact about anything. */
    atMileage: string;
    /**
     * Numbers each ladder when the payload carries more than one valuation.
     *
     * Several valuations are printed as several rows and never merged, so the
     * reader needs to see which figures belong together — by position, since the
     * document does not say who produced them.
     */
    valuation: string;
  };

  values: {
    yes: string;
    no: string;
    unknown: string;
    /** For a headline nobody could answer — not the same as a "no". */
    notChecked: string;
    present: string;
    open: string;
    closed: string;
    stolen: string;
    notStolen: string;
    recovered: string;
    notRecovered: string;
  };

  units: {
    km: string;
    months: string;
    days: string;
    /**
     * Engine power is printed in kilowatts and nothing else.
     *
     * It is the unit the source states and the one the German registration
     * document carries. PS and hp are two DIFFERENT units that differ by about
     * 1.4 %, so a converted figure would have to pick one and be wrong for
     * readers of the other — in a document somebody paid for.
     */
    kw: string;
  };

  notes: {
    suspiciousMileage: string;
    salvage: string;
    airbagDeployed: string;
    defects: string;
    overlapAdjusted: string;
    // v2 only.
    commercialUse: string;
    insuranceTotalLoss: string;
    /** Labels the provider's own brand code, so a disputed brand can be traced. */
    brandCode: string;

    /** Says the figure describes the cohort, not the car it is printed under. */
    timeToSellCohort: string;
    /** Says the date is an expiry, not the date a test was passed. */
    inspectionValidity: string;
    inspectionExpired: string;

    /*
     * The theft-coverage wording. The most consequential lines in the document:
     * a "not stolen" from registers that could never have known about this car
     * is how someone buys a stolen car on the strength of a report.
     */
    /** Prefixes the list of registers that WERE searched. */
    theftRegistersSearched: string;
    /** No register at all was searched. Different from searched-and-clean. */
    theftNoRegisterSearched: string;
    /** Prefixes the countries of this vehicle that no register covered. */
    theftRegistersIncomplete: string;
    /** The document never established which country the vehicle belongs to. */
    theftCountryUnknown: string;
    /** Follows either of the two above: a miss is not a clean result. */
    theftNotProof: string;
  };

  sections: Record<VinHistoryReportSectionId, VinHistorySectionStrings>;

  enums: {
    ownerType: Record<string, string>;
    mileageSource: Record<string, string>;
    damageSeverity: Record<string, string>;
    registrationStatus: Record<string, string>;
    inspectionResult: Record<string, string>;
    damageArea: Record<string, string>;
    /** Coarse brand grouping. The brand's own `label` is NEVER translated. */
    brandCategory: Record<string, string>;
  };

  footer: {
    disclaimer: string;
    page: (current: number, total: number) => string;
  };
}

const DE: VinHistoryPdfStrings = {
  documentTitle: 'Fahrzeughistorie',
  documentSubtitle: 'Herkunftsnachweis zur Fahrgestellnummer',
  meta: {
    vin: 'FIN',
    retrievedAt: 'Datenstand',
    purchasedAt: 'Gekauft am',
    renderedAt: 'Erstellt am',
    purchaseId: 'Beleg-Nr.',
  },
  synthetic: {
    badge: 'GENERIERTE DATEN',
    title: 'Achtung: generierte Daten',
    body:
      'Dieser Bericht enthält KEINE echten Fahrzeugdaten. Die Angaben wurden zu Demonstrations- ' +
      'und Testzwecken erzeugt und dürfen keiner Kauf- oder Preisentscheidung zugrunde gelegt werden.',
    footer: 'Generierte Daten — keine echte Fahrzeughistorie',
  },
  highlights: {
    heading: 'Auf einen Blick',
    records: 'Einträge im Bericht',
    owners: 'Halter',
    countries: 'Länder',
    lastMileage: 'Letzter Kilometerstand',
    firstRegistration: 'Erstzulassung',
    accidents: 'Schadensmeldungen',
    salvage: 'Totalschaden / Restwert',
    rollback: 'Tachomanipulation',
    stolen: 'Diebstahlmeldung',
    openRecalls: 'Offene Rückrufe',
    titleBrands: 'Titel-Vermerke',
    commercialUse: 'Gewerbliche Nutzung (Taxi, Polizei, Miete)',
    insuranceTotalLoss: 'Totalschaden (Versicherung)',
  },
  vehicle: {
    title: 'Fahrzeug',
    make: 'Marke',
    model: 'Modell',
    modelYear: 'Modelljahr',
    bodyClass: 'Karosserie',
    fuelType: 'Kraftstoff',
    transmission: 'Getriebe',
    drivetrain: 'Antrieb',
    enginePower: 'Motorleistung',
    plantCountry: 'Produktionsland',
  },
  sources: {
    title: 'Abgefragte Quellen',
    note:
      'Für diesen Bericht wurden mehrere Datenbestände abgefragt. Ausgewiesen wird, ob die ' +
      'jeweilige Abfrage beantwortet werden konnte; die Quellen werden nach Position und nicht ' +
      'namentlich genannt.',
    columns: ['Quelle', 'Status'],
    position: 'Quelle',
    empty: 'Für diesen Bericht sind keine Quellen ausgewiesen.',
    status: {
      ok: 'Abgefragt',
      failed: 'Nicht erreichbar',
      skipped: 'Nicht abgefragt',
    },
  },
  coverageNotes: {
    unavailable:
      'Diese Quelle war für diesen Bericht nicht erreichbar. Das ist keine Aussage über das Fahrzeug.',
    not_covered:
      'Diese Quelle führt Daten dieser Art nicht. Das ist keine Aussage über das Fahrzeug.',
  },
  closingNote:
    'Dieser Bericht wurde aus mehreren voneinander unabhängigen Fahrzeugdatenquellen zusammengestellt.',
  inspectionValidity: {
    technical: 'Technische Prüfung',
    emissions: 'Abgasuntersuchung',
  },
  equipment: {
    standard: 'Serienausstattung',
    exteriorColors: 'Außenfarben',
    interiorColors: 'Innenfarben',
    warranty: 'Garantie',
    msrp: 'Listenpreis (UVP)',
    invoice: 'Händler-Einkaufspreis',
  },
  marketValue: {
    retail: 'Händlerverkauf',
    tradeIn: 'Inzahlungnahme',
    msrp: 'Listenpreis (UVP)',
    asOf: 'Bewertung vom',
    atMileage: 'Bewertet bei Laufleistung',
    valuation: 'Bewertung',
  },
  values: {
    yes: 'Ja',
    no: 'Nein',
    unknown: 'Unbekannt',
    notChecked: 'Nicht geprüft',
    present: 'bis heute',
    open: 'offen',
    closed: 'erledigt',
    stolen: 'Als gestohlen gemeldet',
    notStolen: 'Keine Diebstahlmeldung',
    recovered: 'Wiedergefunden',
    notRecovered: 'Nicht wiedergefunden',
  },
  units: { km: 'km', months: 'Monate', days: 'Tage', kw: 'kW' },
  notes: {
    suspiciousMileage: 'Auffällig: niedriger als eine frühere Ablesung',
    salvage: 'Als Totalschaden / Restwertfahrzeug erfasst',
    airbagDeployed: 'Airbag ausgelöst',
    defects: 'Mängel',
    overlapAdjusted: 'Ende an den Beginn des nächsten Halters angepasst',
    commercialUse: 'Gewerbliche Nutzung eingetragen (z. B. Taxi, Polizei, Mietwagen)',
    insuranceTotalLoss: 'Von der Versicherung als Totalschaden abgerechnet',
    brandCode: 'Code',
    timeToSellCohort:
      'Gilt für vergleichbare Fahrzeuge in diesem Markt, nicht für dieses Fahrzeug — und ist ' +
      'keine Preisangabe.',
    inspectionValidity:
      'Angegeben ist das Ablaufdatum der Bescheinigung, nicht das Datum einer bestandenen Prüfung.',
    inspectionExpired: 'Abgelaufen',
    theftRegistersSearched: 'Durchsuchte Diebstahlregister',
    theftNoRegisterSearched:
      'Für diesen Bericht wurde kein Diebstahlregister durchsucht. Der Bericht sagt damit nicht ' +
      'aus, ob für dieses Fahrzeug eine Diebstahlmeldung besteht.',
    theftRegistersIncomplete: 'Kein Register durchsucht für folgende Länder dieses Fahrzeugs',
    theftCountryUnknown:
      'Aus diesem Bericht geht nicht hervor, in welchem Land dieses Fahrzeug zugelassen ist.',
    theftNotProof:
      'Ohne Treffer ist das kein Nachweis, dass für dieses Fahrzeug keine Diebstahlmeldung besteht.',
  },
  sections: {
    owners: {
      title: 'Halterhistorie',
      empty: 'Keine Halterdaten vorhanden. Das bedeutet nicht, dass es keine Halterwechsel gab.',
      emptyCovered: 'Geprüft: zu diesem Fahrzeug ist kein Halterwechsel erfasst.',
      columns: ['Nr.', 'Art', 'Land', 'Von', 'Bis', 'Dauer'],
    },
    mileage: {
      title: 'Kilometerstände',
      empty: 'Keine Kilometerstände vorhanden. Das ist keine Bestätigung der Laufleistung.',
      emptyCovered: 'Geprüft: zu diesem Fahrzeug ist kein Kilometerstand gemeldet.',
      columns: ['Datum', 'Stand', 'Quelle', 'Land'],
    },
    damages: {
      title: 'Schäden und Unfälle',
      empty: 'Keine Schadensmeldungen vorhanden. Das ist kein Nachweis der Unfallfreiheit.',
      emptyCovered: 'Geprüft: zu diesem Fahrzeug ist kein Schaden gemeldet.',
      columns: ['Datum', 'Schwere', 'Bereiche', 'Kosten (geschätzt)', 'Totalschaden'],
    },
    registrations: {
      title: 'Zulassungen',
      empty: 'Keine Zulassungsdaten vorhanden.',
      emptyCovered: 'Geprüft: zu diesem Fahrzeug ist keine Zulassung erfasst.',
      columns: ['Land', 'Region', 'Erstzulassung', 'Letzte Zulassung', 'Kennzeichen', 'Status'],
    },
    recalls: {
      title: 'Rückrufaktionen',
      empty: 'Keine Rückrufe erfasst. Prüfen Sie zusätzlich beim Hersteller.',
      emptyCovered:
        'Geprüft: für dieses Fahrzeug ist kein Rückruf erfasst. Prüfen Sie zusätzlich beim Hersteller.',
      columns: ['Referenz', 'Datum', 'Titel', 'Status'],
    },
    theft: {
      title: 'Diebstahlabfrage',
      empty: 'Keine Diebstahlmeldung erfasst.',
      emptyCovered: 'Geprüft: dieses Fahrzeug ist nicht als gestohlen gemeldet.',
      columns: ['Status', 'Gemeldet', 'Land', 'Wiedergefunden'],
    },
    inspections: {
      title: 'Hauptuntersuchungen',
      empty: 'Keine Prüfberichte vorhanden.',
      emptyCovered: 'Geprüft: zu diesem Fahrzeug liegt kein Prüfbericht vor.',
      columns: ['Datum', 'Prüfstelle', 'Ergebnis', 'Stand', 'Land', 'Nächste HU'],
    },
    insurance: {
      title: 'Versicherungsmeldungen',
      empty: 'Keine Versicherungsmeldungen vorhanden.',
      emptyCovered: 'Geprüft: zu diesem Fahrzeug ist keine Versicherungsmeldung erfasst.',
      columns: ['Datum', 'Versicherer', 'Land', 'Totalschaden', 'Grund'],
    },
    brands: {
      title: 'Titel-Vermerke',
      empty: 'Keine Titel-Vermerke vorhanden.',
      emptyCovered: 'Geprüft: für dieses Fahrzeug ist kein Titel-Vermerk eingetragen.',
      columns: ['Gemeldet', 'Vermerk', 'Kategorie', 'Behörde', 'Land'],
    },
    service: {
      title: 'Servicehistorie',
      empty: 'Keine Serviceeinträge vorhanden.',
      emptyCovered: 'Geprüft: zu diesem Fahrzeug ist kein Serviceeintrag erfasst.',
      columns: ['Datum', 'Stand', 'Werkstatt', 'Land', 'Arbeiten'],
    },
    equipment: {
      title: 'Werksausstattung',
      empty: 'Keine Ausstattungsdaten vorhanden.',
      emptyCovered: 'Geprüft: zu diesem Fahrzeug liegen keine Ausstattungsdaten vor.',
      columns: ['Position', 'Angabe'],
    },
    marketValue: {
      title: 'Marktwert',
      empty: 'Keine Marktwertdaten vorhanden.',
      emptyCovered: 'Geprüft: für dieses Fahrzeug liegt keine Bewertung vor.',
      columns: ['Basis', 'Sehr gut', 'Gut', 'Durchschnitt', 'Schlecht'],
    },
    inspectionValidity: {
      title: 'Gültigkeit der Prüfbescheinigungen',
      empty: 'Keine Angaben zur Gültigkeit vorhanden.',
      emptyCovered:
        'Geprüft: zu diesem Fahrzeug ist kein Ablaufdatum einer Prüfbescheinigung hinterlegt.',
      columns: ['Nachweis', 'Land', 'Gültig bis'],
    },
    timeToSell: {
      title: 'Verkaufsdauer vergleichbarer Fahrzeuge',
      empty: 'Keine Angaben zur Verkaufsdauer vorhanden.',
      emptyCovered: 'Geprüft: für vergleichbare Fahrzeuge liegt keine Verkaufsdauer vor.',
      columns: ['Markt', 'Median', 'Unteres Quartil (25 %)', 'Oberes Quartil (75 %)'],
    },
  },
  enums: {
    ownerType: {
      private: 'Privat',
      company: 'Firma',
      lease: 'Leasing',
      rental: 'Mietwagen',
      fleet: 'Flotte',
      government: 'Behörde',
      unknown: 'Unbekannt',
    },
    mileageSource: {
      inspection: 'Hauptuntersuchung',
      service: 'Werkstatt',
      registration: 'Zulassung',
      auction: 'Auktion',
      insurance: 'Versicherung',
      unknown: 'Unbekannt',
    },
    damageSeverity: {
      minor: 'Leicht',
      moderate: 'Mittel',
      severe: 'Schwer',
      total_loss: 'Totalschaden',
      unknown: 'Unbekannt',
    },
    registrationStatus: {
      active: 'Angemeldet',
      deregistered: 'Abgemeldet',
      exported: 'Exportiert',
      scrapped: 'Verschrottet',
      unknown: 'Unbekannt',
    },
    inspectionResult: {
      pass: 'Bestanden',
      pass_with_defects: 'Mit Mängeln bestanden',
      fail: 'Nicht bestanden',
      unknown: 'Unbekannt',
    },
    damageArea: {
      front: 'Front',
      rear: 'Heck',
      left: 'Links',
      right: 'Rechts',
      roof: 'Dach',
      underbody: 'Unterboden',
      interior: 'Innenraum',
    },
    brandCategory: {
      salvage: 'Totalschaden / Restwert',
      flood: 'Wasserschaden',
      fire: 'Brandschaden',
      odometer: 'Tachostand',
      commercial: 'Gewerbliche Nutzung',
      theft: 'Diebstahl',
      lemon: 'Rückkauf durch Hersteller',
      export: 'Aus- / Einfuhr',
      other: 'Sonstiges',
    },
  },
  footer: {
    disclaimer: 'CarSalePro — Fahrzeughistorie',
    page: (current, total) => `Seite ${current} / ${total}`,
  },
};

const EN: VinHistoryPdfStrings = {
  documentTitle: 'Vehicle history',
  documentSubtitle: 'Provenance record for this VIN',
  meta: {
    vin: 'VIN',
    retrievedAt: 'Data as of',
    purchasedAt: 'Purchased',
    renderedAt: 'Generated',
    purchaseId: 'Receipt no.',
  },
  synthetic: {
    badge: 'GENERATED DATA',
    title: 'Warning: generated data',
    body:
      'This report contains NO real vehicle data. The entries were generated for demonstration ' +
      'and testing and must not be used to make a purchase or pricing decision.',
    footer: 'Generated data — not a real vehicle history',
  },
  highlights: {
    heading: 'At a glance',
    records: 'Records in this report',
    owners: 'Owners',
    countries: 'Countries',
    lastMileage: 'Last recorded mileage',
    firstRegistration: 'First registration',
    accidents: 'Damage records',
    salvage: 'Salvage / total loss',
    rollback: 'Odometer rollback',
    stolen: 'Theft record',
    openRecalls: 'Open recalls',
    titleBrands: 'Title brands',
    commercialUse: 'Commercial use (taxi, police, rental)',
    insuranceTotalLoss: 'Insurance total loss',
  },
  vehicle: {
    title: 'Vehicle',
    make: 'Make',
    model: 'Model',
    modelYear: 'Model year',
    bodyClass: 'Body',
    fuelType: 'Fuel',
    transmission: 'Transmission',
    drivetrain: 'Drivetrain',
    enginePower: 'Engine power',
    plantCountry: 'Plant country',
  },
  sources: {
    title: 'Sources consulted',
    note:
      'Several datasets were queried for this report. What is stated is whether each query was ' +
      'answered; the sources are listed by position and are not named.',
    columns: ['Source', 'Status'],
    position: 'Source',
    empty: 'No sources are stated for this report.',
    status: {
      ok: 'Queried',
      failed: 'Unavailable',
      skipped: 'Not queried',
    },
  },
  coverageNotes: {
    unavailable:
      'This source could not be reached for this report. That is not a statement about the vehicle.',
    not_covered:
      'This source does not hold records of this kind. That is not a statement about the vehicle.',
  },
  closingNote: 'This report was compiled from several independent vehicle-data sources.',
  inspectionValidity: {
    technical: 'Roadworthiness test',
    emissions: 'Emissions test',
  },
  equipment: {
    standard: 'Standard equipment',
    exteriorColors: 'Exterior colours',
    interiorColors: 'Interior colours',
    warranty: 'Warranty',
    msrp: 'List price (MSRP)',
    invoice: 'Dealer invoice price',
  },
  marketValue: {
    retail: 'Retail',
    tradeIn: 'Trade-in',
    msrp: 'List price (MSRP)',
    asOf: 'Valuation date',
    atMileage: 'Valued at mileage',
    valuation: 'Valuation',
  },
  values: {
    yes: 'Yes',
    no: 'No',
    unknown: 'Unknown',
    notChecked: 'Not checked',
    present: 'to date',
    open: 'open',
    closed: 'closed',
    stolen: 'Reported stolen',
    notStolen: 'No theft record',
    recovered: 'Recovered',
    notRecovered: 'Not recovered',
  },
  units: { km: 'km', months: 'months', days: 'days', kw: 'kW' },
  notes: {
    suspiciousMileage: 'Suspicious: lower than an earlier reading',
    salvage: 'Recorded as salvage / total loss',
    airbagDeployed: 'Airbag deployed',
    defects: 'Defects',
    overlapAdjusted: 'End adjusted to the start of the next owner',
    commercialUse: 'Commercial use recorded (for example taxi, police or rental)',
    insuranceTotalLoss: 'Written off as a total loss by an insurer',
    brandCode: 'Code',
    timeToSellCohort:
      'Describes comparable vehicles in this market, not this vehicle — and is not a price for it.',
    inspectionValidity:
      'This is the expiry date of the certificate, not the date on which a test was passed.',
    inspectionExpired: 'Expired',
    theftRegistersSearched: 'Theft registers searched',
    theftNoRegisterSearched:
      'No theft register was searched for this report. It therefore says nothing about whether ' +
      'this vehicle is reported stolen.',
    theftRegistersIncomplete: 'No register searched for these countries of this vehicle',
    theftCountryUnknown:
      'This report does not establish which country this vehicle is registered in.',
    theftNotProof:
      'Without a hit, that is not proof that no theft report exists for this vehicle.',
  },
  sections: {
    owners: {
      title: 'Ownership history',
      empty: 'No ownership records held. This does not mean the car had no owner changes.',
      emptyCovered: 'Checked: no owner change is recorded for this vehicle.',
      columns: ['No.', 'Type', 'Country', 'From', 'To', 'Duration'],
    },
    mileage: {
      title: 'Mileage readings',
      empty: 'No mileage readings held. This is not a confirmation of the odometer.',
      emptyCovered: 'Checked: no mileage reading has been reported for this vehicle.',
      columns: ['Date', 'Reading', 'Source', 'Country'],
    },
    damages: {
      title: 'Damage and accidents',
      empty: 'No damage records held. This is not proof the car is accident-free.',
      emptyCovered: 'Checked: no damage has been reported for this vehicle.',
      columns: ['Date', 'Severity', 'Areas', 'Estimated repair', 'Salvage'],
    },
    registrations: {
      title: 'Registrations',
      empty: 'No registration records held.',
      emptyCovered: 'Checked: no registration is recorded for this vehicle.',
      columns: ['Country', 'Region', 'First registration', 'Last registration', 'Plate', 'Status'],
    },
    recalls: {
      title: 'Recalls',
      empty: 'No recalls recorded. Check with the manufacturer as well.',
      emptyCovered:
        'Checked: no recall is recorded for this vehicle. Check with the manufacturer as well.',
      columns: ['Reference', 'Issued', 'Title', 'Status'],
    },
    theft: {
      title: 'Theft check',
      empty: 'No theft record held.',
      emptyCovered: 'Checked: this vehicle is not reported stolen.',
      columns: ['Status', 'Reported', 'Country', 'Recovered'],
    },
    inspections: {
      title: 'Roadworthiness inspections',
      empty: 'No inspection records held.',
      emptyCovered: 'Checked: no inspection record exists for this vehicle.',
      columns: ['Date', 'Authority', 'Result', 'Reading', 'Country', 'Next due'],
    },
    insurance: {
      title: 'Insurance records',
      empty: 'No insurance records held.',
      emptyCovered: 'Checked: no insurance record is held for this vehicle.',
      columns: ['Date', 'Insurer', 'Country', 'Total loss', 'Reason'],
    },
    brands: {
      title: 'Title brands',
      empty: 'No title brands held.',
      emptyCovered: 'Checked: no title brand is recorded for this vehicle.',
      columns: ['Reported', 'Brand', 'Category', 'Authority', 'Country'],
    },
    service: {
      title: 'Service history',
      empty: 'No service records held.',
      emptyCovered: 'Checked: no service visit is recorded for this vehicle.',
      columns: ['Date', 'Reading', 'Facility', 'Country', 'Work'],
    },
    equipment: {
      title: 'Factory equipment',
      empty: 'No equipment data held.',
      emptyCovered: 'Checked: no equipment data is held for this vehicle.',
      columns: ['Item', 'Detail'],
    },
    marketValue: {
      title: 'Market value',
      empty: 'No valuation held.',
      emptyCovered: 'Checked: no valuation is published for this vehicle.',
      columns: ['Basis', 'Excellent', 'Clean', 'Average', 'Rough'],
    },
    inspectionValidity: {
      title: 'Inspection certificate validity',
      empty: 'No validity dates held.',
      emptyCovered: 'Checked: no certificate expiry date is held for this vehicle.',
      columns: ['Certificate', 'Country', 'Valid until'],
    },
    timeToSell: {
      title: 'Time to sell for comparable vehicles',
      empty: 'No time-to-sell figures held.',
      emptyCovered: 'Checked: no time to sell is published for comparable vehicles.',
      columns: ['Market', 'Median', 'Lower quartile (25%)', 'Upper quartile (75%)'],
    },
  },
  enums: {
    ownerType: {
      private: 'Private',
      company: 'Company',
      lease: 'Lease',
      rental: 'Rental',
      fleet: 'Fleet',
      government: 'Government',
      unknown: 'Unknown',
    },
    mileageSource: {
      inspection: 'Inspection',
      service: 'Service',
      registration: 'Registration',
      auction: 'Auction',
      insurance: 'Insurance',
      unknown: 'Unknown',
    },
    damageSeverity: {
      minor: 'Minor',
      moderate: 'Moderate',
      severe: 'Severe',
      total_loss: 'Total loss',
      unknown: 'Unknown',
    },
    registrationStatus: {
      active: 'Active',
      deregistered: 'Deregistered',
      exported: 'Exported',
      scrapped: 'Scrapped',
      unknown: 'Unknown',
    },
    inspectionResult: {
      pass: 'Pass',
      pass_with_defects: 'Pass with defects',
      fail: 'Fail',
      unknown: 'Unknown',
    },
    damageArea: {
      front: 'Front',
      rear: 'Rear',
      left: 'Left',
      right: 'Right',
      roof: 'Roof',
      underbody: 'Underbody',
      interior: 'Interior',
    },
    brandCategory: {
      salvage: 'Salvage / total loss',
      flood: 'Flood damage',
      fire: 'Fire damage',
      odometer: 'Odometer',
      commercial: 'Commercial use',
      theft: 'Theft',
      lemon: 'Manufacturer buyback',
      export: 'Import / export',
      other: 'Other',
    },
  },
  footer: {
    disclaimer: 'CarSalePro — vehicle history',
    page: (current, total) => `Page ${current} / ${total}`,
  },
};

const RU: VinHistoryPdfStrings = {
  documentTitle: 'История автомобиля',
  documentSubtitle: 'Отчёт о происхождении по VIN',
  meta: {
    vin: 'VIN',
    retrievedAt: 'Данные на',
    purchasedAt: 'Куплено',
    renderedAt: 'Сформировано',
    purchaseId: 'Номер покупки',
  },
  synthetic: {
    badge: 'СГЕНЕРИРОВАННЫЕ ДАННЫЕ',
    title: 'Внимание: данные сгенерированы',
    body:
      'В этом отчёте НЕТ реальных данных об автомобиле. Записи созданы для демонстрации и ' +
      'тестирования и не могут служить основанием для покупки или оценки стоимости.',
    footer: 'Сгенерированные данные — не реальная история автомобиля',
  },
  highlights: {
    heading: 'Кратко',
    records: 'Записей в отчёте',
    owners: 'Владельцев',
    countries: 'Стран',
    lastMileage: 'Последний пробег',
    firstRegistration: 'Первая регистрация',
    accidents: 'Записи о повреждениях',
    salvage: 'Тотал / утилизация',
    rollback: 'Скрутка пробега',
    stolen: 'Розыск / угон',
    openRecalls: 'Открытые отзывы',
    titleBrands: 'Отметки в титуле',
    commercialUse: 'Коммерческое использование (такси, полиция, прокат)',
    insuranceTotalLoss: 'Тотал по страховке',
  },
  vehicle: {
    title: 'Автомобиль',
    make: 'Марка',
    model: 'Модель',
    modelYear: 'Модельный год',
    bodyClass: 'Кузов',
    fuelType: 'Топливо',
    transmission: 'Коробка передач',
    drivetrain: 'Привод',
    enginePower: 'Мощность двигателя',
    plantCountry: 'Страна сборки',
  },
  sources: {
    title: 'Запрошенные источники',
    note:
      'Для этого отчёта было запрошено несколько наборов данных. Указано, был ли получен ответ ' +
      'на каждый запрос; источники перечислены по позициям и не называются.',
    columns: ['Источник', 'Статус'],
    position: 'Источник',
    empty: 'Источники для этого отчёта не указаны.',
    status: {
      ok: 'Запрошен',
      failed: 'Недоступен',
      skipped: 'Не запрашивался',
    },
  },
  coverageNotes: {
    unavailable:
      'Этот источник не удалось запросить для данного отчёта. Это не утверждение об автомобиле.',
    not_covered:
      'Этот источник не хранит данные такого рода. Это не утверждение об автомобиле.',
  },
  closingNote:
    'Этот отчёт составлен по нескольким независимым источникам данных об автомобилях.',
  inspectionValidity: {
    technical: 'Технический осмотр',
    emissions: 'Проверка выбросов',
  },
  equipment: {
    standard: 'Базовая комплектация',
    exteriorColors: 'Цвета кузова',
    interiorColors: 'Цвета салона',
    warranty: 'Гарантия',
    msrp: 'Цена по прайсу (MSRP)',
    invoice: 'Дилерская цена',
  },
  marketValue: {
    retail: 'Розница',
    tradeIn: 'Трейд-ин',
    msrp: 'Цена по прайсу (MSRP)',
    asOf: 'Дата оценки',
    atMileage: 'Оценка при пробеге',
    valuation: 'Оценка',
  },
  values: {
    yes: 'Да',
    no: 'Нет',
    unknown: 'Неизвестно',
    notChecked: 'Не проверялось',
    present: 'по настоящее время',
    open: 'открыт',
    closed: 'закрыт',
    stolen: 'Заявлен в угон',
    notStolen: 'Записей об угоне нет',
    recovered: 'Найден',
    notRecovered: 'Не найден',
  },
  units: { km: 'км', months: 'мес.', days: 'дн.', kw: 'кВт' },
  notes: {
    suspiciousMileage: 'Подозрительно: меньше предыдущего показания',
    salvage: 'Учтён как тотал / утилизация',
    airbagDeployed: 'Подушки безопасности сработали',
    defects: 'Замечания',
    overlapAdjusted: 'Окончание приведено к началу следующего владения',
    commercialUse: 'Зафиксировано коммерческое использование (например, такси, полиция, прокат)',
    insuranceTotalLoss: 'Списан страховщиком как тотал',
    brandCode: 'Код',
    timeToSellCohort:
      'Относится к сопоставимым автомобилям на этом рынке, а не к данному автомобилю, и не ' +
      'является его ценой.',
    inspectionValidity:
      'Указана дата окончания действия документа, а не дата пройденной проверки.',
    inspectionExpired: 'Истёк',
    theftRegistersSearched: 'Проверенные реестры угона',
    theftNoRegisterSearched:
      'Для этого отчёта не проверялся ни один реестр угона. Отчёт не сообщает, заявлен ли ' +
      'автомобиль в угон.',
    theftRegistersIncomplete: 'Реестры не проверялись для следующих стран этого автомобиля',
    theftCountryUnknown:
      'Из этого отчёта не следует, в какой стране зарегистрирован автомобиль.',
    theftNotProof:
      'Отсутствие совпадения не доказывает, что заявления об угоне нет.',
  },
  sections: {
    owners: {
      title: 'История владения',
      empty: 'Данных о владельцах нет. Это не означает, что владелец не менялся.',
      emptyCovered: 'Проверено: смен владельца по этому автомобилю не зарегистрировано.',
      columns: ['№', 'Тип', 'Страна', 'С', 'По', 'Срок'],
    },
    mileage: {
      title: 'Показания пробега',
      empty: 'Показаний пробега нет. Это не подтверждение пробега.',
      emptyCovered: 'Проверено: показаний пробега по этому автомобилю не зафиксировано.',
      columns: ['Дата', 'Пробег', 'Источник', 'Страна'],
    },
    damages: {
      title: 'Повреждения и ДТП',
      empty: 'Записей о повреждениях нет. Это не доказательство отсутствия ДТП.',
      emptyCovered: 'Проверено: сообщений о повреждениях этого автомобиля нет.',
      columns: ['Дата', 'Тяжесть', 'Зоны', 'Оценка ремонта', 'Тотал'],
    },
    registrations: {
      title: 'Регистрации',
      empty: 'Данных о регистрациях нет.',
      emptyCovered: 'Проверено: регистраций по этому автомобилю не найдено.',
      columns: ['Страна', 'Регион', 'Первая регистрация', 'Последняя регистрация', 'Номер', 'Статус'],
    },
    recalls: {
      title: 'Отзывные кампании',
      empty: 'Отзывных кампаний не найдено. Уточните также у производителя.',
      emptyCovered:
        'Проверено: отзывных кампаний по этому автомобилю нет. Уточните также у производителя.',
      columns: ['Номер', 'Дата', 'Название', 'Статус'],
    },
    theft: {
      title: 'Проверка на угон',
      empty: 'Записей об угоне нет.',
      emptyCovered: 'Проверено: автомобиль в угоне не числится.',
      columns: ['Статус', 'Заявлено', 'Страна', 'Найден'],
    },
    inspections: {
      title: 'Технические осмотры',
      empty: 'Данных о техосмотрах нет.',
      emptyCovered: 'Проверено: данных о техосмотрах этого автомобиля нет.',
      columns: ['Дата', 'Организация', 'Результат', 'Пробег', 'Страна', 'Следующий'],
    },
    insurance: {
      title: 'Страховые записи',
      empty: 'Страховых записей нет.',
      emptyCovered: 'Проверено: страховых записей по этому автомобилю нет.',
      columns: ['Дата', 'Страховщик', 'Страна', 'Тотал', 'Причина'],
    },
    brands: {
      title: 'Отметки в титуле',
      empty: 'Отметок в титуле нет.',
      emptyCovered: 'Проверено: отметок в титуле по этому автомобилю не зарегистрировано.',
      columns: ['Заявлено', 'Отметка', 'Категория', 'Орган', 'Страна'],
    },
    service: {
      title: 'История обслуживания',
      empty: 'Записей об обслуживании нет.',
      emptyCovered: 'Проверено: записей об обслуживании этого автомобиля нет.',
      columns: ['Дата', 'Пробег', 'Сервис', 'Страна', 'Работы'],
    },
    equipment: {
      title: 'Заводская комплектация',
      empty: 'Данных о комплектации нет.',
      emptyCovered: 'Проверено: данных о комплектации этого автомобиля нет.',
      columns: ['Позиция', 'Значение'],
    },
    marketValue: {
      title: 'Рыночная стоимость',
      empty: 'Данных об оценке нет.',
      emptyCovered: 'Проверено: оценка этого автомобиля не публикуется.',
      columns: ['База', 'Отличное', 'Хорошее', 'Среднее', 'Плохое'],
    },
    inspectionValidity: {
      title: 'Срок действия документов о проверках',
      empty: 'Данных о сроке действия нет.',
      emptyCovered: 'Проверено: дата окончания действия по этому автомобилю не хранится.',
      columns: ['Документ', 'Страна', 'Действует до'],
    },
    timeToSell: {
      title: 'Срок продажи сопоставимых автомобилей',
      empty: 'Данных о сроке продажи нет.',
      emptyCovered: 'Проверено: срок продажи сопоставимых автомобилей не публикуется.',
      columns: ['Рынок', 'Медиана', 'Нижний квартиль (25 %)', 'Верхний квартиль (75 %)'],
    },
  },
  enums: {
    ownerType: {
      private: 'Частное лицо',
      company: 'Компания',
      lease: 'Лизинг',
      rental: 'Прокат',
      fleet: 'Автопарк',
      government: 'Госорган',
      unknown: 'Неизвестно',
    },
    mileageSource: {
      inspection: 'Техосмотр',
      service: 'Сервис',
      registration: 'Регистрация',
      auction: 'Аукцион',
      insurance: 'Страхование',
      unknown: 'Неизвестно',
    },
    damageSeverity: {
      minor: 'Незначительные',
      moderate: 'Средние',
      severe: 'Тяжёлые',
      total_loss: 'Тотал',
      unknown: 'Неизвестно',
    },
    registrationStatus: {
      active: 'На учёте',
      deregistered: 'Снят с учёта',
      exported: 'Вывезен',
      scrapped: 'Утилизирован',
      unknown: 'Неизвестно',
    },
    inspectionResult: {
      pass: 'Пройден',
      pass_with_defects: 'Пройден с замечаниями',
      fail: 'Не пройден',
      unknown: 'Неизвестно',
    },
    damageArea: {
      front: 'Перед',
      rear: 'Зад',
      left: 'Левая сторона',
      right: 'Правая сторона',
      roof: 'Крыша',
      underbody: 'Днище',
      interior: 'Салон',
    },
    brandCategory: {
      salvage: 'Тотал / утилизация',
      flood: 'Затопление',
      fire: 'Пожар',
      odometer: 'Пробег',
      commercial: 'Коммерческое использование',
      theft: 'Угон',
      lemon: 'Выкуп производителем',
      export: 'Ввоз / вывоз',
      other: 'Прочее',
    },
  },
  footer: {
    disclaimer: 'CarSalePro — история автомобиля',
    page: (current, total) => `Стр. ${current} / ${total}`,
  },
};

export const VIN_HISTORY_PDF_STRINGS: Record<VinHistoryPdfLocale, VinHistoryPdfStrings> = {
  de: DE,
  en: EN,
  ru: RU,
};

export function vinHistoryPdfStrings(locale?: string | null): VinHistoryPdfStrings {
  return VIN_HISTORY_PDF_STRINGS[resolveVinHistoryPdfLocale(locale)];
}
