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
 * The dictionary is a total `Record` over the locale union and over the seven
 * section ids: a missing translation is a compile error, not a blank cell in a
 * document someone paid for.
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
  /** Printed INSTEAD of rows when the section is empty — never omitted. */
  empty: string;
  columns: string[];
}

export interface VinHistoryPdfStrings {
  documentTitle: string;
  documentSubtitle: string;

  meta: {
    vin: string;
    provider: string;
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
  };

  values: {
    yes: string;
    no: string;
    unknown: string;
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
  };

  notes: {
    suspiciousMileage: string;
    salvage: string;
    airbagDeployed: string;
    defects: string;
    overlapAdjusted: string;
  };

  sections: Record<VinHistoryReportSectionId, VinHistorySectionStrings>;

  enums: {
    ownerType: Record<string, string>;
    mileageSource: Record<string, string>;
    damageSeverity: Record<string, string>;
    registrationStatus: Record<string, string>;
    inspectionResult: Record<string, string>;
    damageArea: Record<string, string>;
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
    provider: 'Datenquelle',
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
  },
  values: {
    yes: 'Ja',
    no: 'Nein',
    unknown: 'Unbekannt',
    present: 'bis heute',
    open: 'offen',
    closed: 'erledigt',
    stolen: 'Als gestohlen gemeldet',
    notStolen: 'Keine Diebstahlmeldung',
    recovered: 'Wiedergefunden',
    notRecovered: 'Nicht wiedergefunden',
  },
  units: { km: 'km', months: 'Monate' },
  notes: {
    suspiciousMileage: 'Auffällig: niedriger als eine frühere Ablesung',
    salvage: 'Als Totalschaden / Restwertfahrzeug erfasst',
    airbagDeployed: 'Airbag ausgelöst',
    defects: 'Mängel',
    overlapAdjusted: 'Ende an den Beginn des nächsten Halters angepasst',
  },
  sections: {
    owners: {
      title: 'Halterhistorie',
      empty: 'Keine Halterdaten vorhanden. Das bedeutet nicht, dass es keine Halterwechsel gab.',
      columns: ['Nr.', 'Art', 'Land', 'Von', 'Bis', 'Dauer'],
    },
    mileage: {
      title: 'Kilometerstände',
      empty: 'Keine Kilometerstände vorhanden. Das ist keine Bestätigung der Laufleistung.',
      columns: ['Datum', 'Stand', 'Quelle', 'Land'],
    },
    damages: {
      title: 'Schäden und Unfälle',
      empty: 'Keine Schadensmeldungen vorhanden. Das ist kein Nachweis der Unfallfreiheit.',
      columns: ['Datum', 'Schwere', 'Bereiche', 'Kosten (geschätzt)', 'Totalschaden'],
    },
    registrations: {
      title: 'Zulassungen',
      empty: 'Keine Zulassungsdaten vorhanden.',
      columns: ['Land', 'Region', 'Erstzulassung', 'Letzte Zulassung', 'Kennzeichen', 'Status'],
    },
    recalls: {
      title: 'Rückrufaktionen',
      empty: 'Keine Rückrufe erfasst. Prüfen Sie zusätzlich beim Hersteller.',
      columns: ['Referenz', 'Datum', 'Behörde', 'Titel', 'Status'],
    },
    theft: {
      title: 'Diebstahlabfrage',
      empty: 'Keine Diebstahlmeldung erfasst.',
      columns: ['Status', 'Gemeldet', 'Land', 'Wiedergefunden', 'Quelle'],
    },
    inspections: {
      title: 'Hauptuntersuchungen',
      empty: 'Keine Prüfberichte vorhanden.',
      columns: ['Datum', 'Prüfstelle', 'Ergebnis', 'Stand', 'Land', 'Nächste HU'],
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
    provider: 'Data source',
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
  },
  values: {
    yes: 'Yes',
    no: 'No',
    unknown: 'Unknown',
    present: 'to date',
    open: 'open',
    closed: 'closed',
    stolen: 'Reported stolen',
    notStolen: 'No theft record',
    recovered: 'Recovered',
    notRecovered: 'Not recovered',
  },
  units: { km: 'km', months: 'months' },
  notes: {
    suspiciousMileage: 'Suspicious: lower than an earlier reading',
    salvage: 'Recorded as salvage / total loss',
    airbagDeployed: 'Airbag deployed',
    defects: 'Defects',
    overlapAdjusted: 'End adjusted to the start of the next owner',
  },
  sections: {
    owners: {
      title: 'Ownership history',
      empty: 'No ownership records held. This does not mean the car had no owner changes.',
      columns: ['No.', 'Type', 'Country', 'From', 'To', 'Duration'],
    },
    mileage: {
      title: 'Mileage readings',
      empty: 'No mileage readings held. This is not a confirmation of the odometer.',
      columns: ['Date', 'Reading', 'Source', 'Country'],
    },
    damages: {
      title: 'Damage and accidents',
      empty: 'No damage records held. This is not proof the car is accident-free.',
      columns: ['Date', 'Severity', 'Areas', 'Estimated repair', 'Salvage'],
    },
    registrations: {
      title: 'Registrations',
      empty: 'No registration records held.',
      columns: ['Country', 'Region', 'First registration', 'Last registration', 'Plate', 'Status'],
    },
    recalls: {
      title: 'Recalls',
      empty: 'No recalls recorded. Check with the manufacturer as well.',
      columns: ['Reference', 'Issued', 'Authority', 'Title', 'Status'],
    },
    theft: {
      title: 'Theft check',
      empty: 'No theft record held.',
      columns: ['Status', 'Reported', 'Country', 'Recovered', 'Source'],
    },
    inspections: {
      title: 'Roadworthiness inspections',
      empty: 'No inspection records held.',
      columns: ['Date', 'Authority', 'Result', 'Reading', 'Country', 'Next due'],
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
    provider: 'Источник данных',
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
  },
  values: {
    yes: 'Да',
    no: 'Нет',
    unknown: 'Неизвестно',
    present: 'по настоящее время',
    open: 'открыт',
    closed: 'закрыт',
    stolen: 'Заявлен в угон',
    notStolen: 'Записей об угоне нет',
    recovered: 'Найден',
    notRecovered: 'Не найден',
  },
  units: { km: 'км', months: 'мес.' },
  notes: {
    suspiciousMileage: 'Подозрительно: меньше предыдущего показания',
    salvage: 'Учтён как тотал / утилизация',
    airbagDeployed: 'Подушки безопасности сработали',
    defects: 'Замечания',
    overlapAdjusted: 'Окончание приведено к началу следующего владения',
  },
  sections: {
    owners: {
      title: 'История владения',
      empty: 'Данных о владельцах нет. Это не означает, что владелец не менялся.',
      columns: ['№', 'Тип', 'Страна', 'С', 'По', 'Срок'],
    },
    mileage: {
      title: 'Показания пробега',
      empty: 'Показаний пробега нет. Это не подтверждение пробега.',
      columns: ['Дата', 'Пробег', 'Источник', 'Страна'],
    },
    damages: {
      title: 'Повреждения и ДТП',
      empty: 'Записей о повреждениях нет. Это не доказательство отсутствия ДТП.',
      columns: ['Дата', 'Тяжесть', 'Зоны', 'Оценка ремонта', 'Тотал'],
    },
    registrations: {
      title: 'Регистрации',
      empty: 'Данных о регистрациях нет.',
      columns: ['Страна', 'Регион', 'Первая регистрация', 'Последняя регистрация', 'Номер', 'Статус'],
    },
    recalls: {
      title: 'Отзывные кампании',
      empty: 'Отзывных кампаний не найдено. Уточните также у производителя.',
      columns: ['Номер', 'Дата', 'Орган', 'Название', 'Статус'],
    },
    theft: {
      title: 'Проверка на угон',
      empty: 'Записей об угоне нет.',
      columns: ['Статус', 'Заявлено', 'Страна', 'Найден', 'Источник'],
    },
    inspections: {
      title: 'Технические осмотры',
      empty: 'Данных о техосмотрах нет.',
      columns: ['Дата', 'Организация', 'Результат', 'Пробег', 'Страна', 'Следующий'],
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
