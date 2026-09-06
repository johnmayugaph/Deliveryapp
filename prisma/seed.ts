import {
  BenefitType,
  FulfilmentType,
  IntentGroup,
  PrismaClient,
  ServiceKey,
  UserRole,
  VehicleType,
  VerificationStatus,
} from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seeds.
 *
 * This file is the ONE place in the codebase that enumerates the five services.
 * That is the point of the registry: the list lives in data, and every consumer
 * reads it back from `Service`. If you find yourself wanting a second list
 * somewhere, read from the registry instead.
 */

const CITIES = [
  { id: 'city_manila', name: 'Manila', province: 'Metro Manila', region: 'NCR', centroidLat: 14.5995, centroidLng: 120.9842 },
  { id: 'city_quezon', name: 'Quezon City', province: 'Metro Manila', region: 'NCR', centroidLat: 14.676, centroidLng: 121.0437 },
  { id: 'city_makati', name: 'Makati', province: 'Metro Manila', region: 'NCR', centroidLat: 14.5547, centroidLng: 121.0244 },
  { id: 'city_cebu', name: 'Cebu City', province: 'Cebu', region: 'Central Visayas', centroidLat: 10.3157, centroidLng: 123.8854 },
  { id: 'city_davao', name: 'Davao City', province: 'Davao del Sur', region: 'Davao', centroidLat: 7.1907, centroidLng: 125.4553 },
];

/** Where FOOD is live at launch. Deliberately small. */
const FOOD_LAUNCH_CITIES = ['city_manila', 'city_quezon', 'city_makati'];

/**
 * All five verticals. Only FOOD is active; the other four exist as
 * `isComingSoon` records so the home screen can render them dimmed with a
 * "Coming soon" label — which also lets us measure demand for each before
 * committing engineering to any of them.
 */
const SERVICES = [
  {
    key: ServiceKey.FOOD,
    displayName: 'Kainan',
    tagline: 'Food delivery',
    icon: 'utensils',
    description: 'Order from restaurants and karinderya near you, delivered hot.',
    intentGroup: IntentGroup.EAT,
    isActive: true,
    isComingSoon: false,
    sortOrder: 10,
    fulfilmentType: FulfilmentType.MERCHANT_TO_DOOR,
    requiresMerchant: true,
    requiresRider: true,
    availableCityIds: FOOD_LAUNCH_CITIES,
    accentToken: 'food',
  },
  {
    key: ServiceKey.MART,
    displayName: 'Tindahan',
    tagline: 'Grocery at sari-sari',
    icon: 'shopping-basket',
    description: 'Groceries and sari-sari staples, shopped for you and delivered.',
    intentGroup: IntentGroup.EAT,
    isActive: false,
    isComingSoon: true,
    sortOrder: 20,
    fulfilmentType: FulfilmentType.SHOPPER_TO_DOOR,
    requiresMerchant: true,
    requiresRider: true,
    availableCityIds: [],
    accentToken: 'mart',
  },
  {
    key: ServiceKey.PARCEL,
    displayName: 'Padala',
    tagline: 'Same-day parcel',
    icon: 'package',
    description: 'Send a parcel across the city on the same day.',
    intentGroup: IntentGroup.GET,
    isActive: false,
    isComingSoon: true,
    sortOrder: 30,
    fulfilmentType: FulfilmentType.POINT_TO_POINT,
    requiresMerchant: false,
    requiresRider: true,
    availableCityIds: [],
    accentToken: 'parcel',
  },
  {
    key: ServiceKey.PABILI,
    displayName: 'Pabili',
    tagline: 'Ipamili mo sa amin',
    icon: 'clipboard-list',
    description: 'Tell us what to buy and where. We shop it and bring it over.',
    intentGroup: IntentGroup.GET,
    isActive: false,
    isComingSoon: true,
    sortOrder: 40,
    fulfilmentType: FulfilmentType.SHOPPER_TO_DOOR,
    requiresMerchant: false,
    requiresRider: true,
    availableCityIds: [],
    accentToken: 'pabili',
  },
  {
    key: ServiceKey.RIDE,
    displayName: 'Sakay',
    tagline: 'Motorcycle at car',
    icon: 'bike',
    description: 'Get a ride to where you need to be.',
    intentGroup: IntentGroup.GO,
    isActive: false,
    isComingSoon: true,
    sortOrder: 50,
    fulfilmentType: FulfilmentType.PASSENGER,
    requiresMerchant: false,
    requiresRider: true,
    availableCityIds: [],
    accentToken: 'ride',
  },
];

async function seedCities() {
  for (const city of CITIES) {
    await prisma.city.upsert({
      where: { id: city.id },
      create: city,
      update: city,
    });
  }
  console.log(`  cities: ${CITIES.length}`);
}

async function seedServices() {
  for (const service of SERVICES) {
    await prisma.service.upsert({
      where: { key: service.key },
      create: service,
      update: service,
    });
  }
  const active = SERVICES.filter((s) => s.isActive).map((s) => s.key);
  console.log(`  services: ${SERVICES.length} (active: ${active.join(', ') || 'none'})`);
}

/**
 * FAQ categories, one per service plus a general section. Driven by the
 * registry: the help screen groups these by `serviceType`, so a coming-soon
 * service's category simply does not appear until we write articles for it.
 */
async function seedFaq() {
  const categories = [
    {
      slug: 'general-account',
      title: 'Account at app',
      serviceType: null,
      sortOrder: 0,
      articles: [
        {
          question: 'Paano ko babaguhin ang delivery address ko?',
          answer:
            'Tap the location at the top of the home screen. Your saved addresses are shared across every service, so an address you save for food is ready for a parcel pickup too.',
        },
        {
          question: 'Puwede ba akong maging rider at customer sa isang account?',
          answer:
            'Yes. One account holds both roles. Switch between ordering and accepting jobs from your Profile.',
        },
      ],
    },
    {
      slug: 'food-orders',
      title: 'Kainan',
      serviceType: ServiceKey.FOOD,
      sortOrder: 10,
      articles: [
        {
          question: 'Bakit hindi pa tinatanggap ng store ang order ko?',
          answer:
            'Restaurants confirm orders themselves. If nobody confirms within a few minutes we cancel and return anything you paid to your Credits.',
        },
        {
          question: 'Puwede ko bang kanselahin ang order?',
          answer:
            'You can cancel any time before the store starts preparing. After that, message us from the order and we will sort it out.',
        },
      ],
    },
    {
      slug: 'credits-rewards',
      title: 'Credits at rewards',
      serviceType: null,
      sortOrder: 20,
      articles: [
        {
          question: 'Ano ang Credits?',
          answer:
            'Credits are rewards we give you — promos, referral bonuses, and refunds. You spend them on orders inside the app.',
        },
        {
          question: 'Puwede ba akong mag-load ng Credits o mag-withdraw?',
          answer:
            'No. Credits are not an e-wallet. You cannot top them up with your own money, send them to another person, or cash them out. They are only spendable on orders here.',
        },
      ],
    },
  ];

  for (const category of categories) {
    const { articles, ...categoryData } = category;
    const saved = await prisma.faqCategory.upsert({
      where: { slug: category.slug },
      create: categoryData,
      update: categoryData,
    });
    // Replace rather than merge: FAQ copy is edited wholesale.
    await prisma.faqArticle.deleteMany({ where: { categoryId: saved.id } });
    await prisma.faqArticle.createMany({
      data: articles.map((article, index) => ({
        categoryId: saved.id,
        question: article.question,
        answer: article.answer,
        sortOrder: index,
      })),
    });
  }
  console.log(`  faq categories: ${categories.length}`);
}

/**
 * One subscription plan, seeded INACTIVE. The pricing engine ignores an
 * inactive plan entirely, so this is safe to leave in place until we decide to
 * launch it.
 */
async function seedSubscriptionPlan() {
  const plan = await prisma.subscriptionPlan.upsert({
    where: { slug: 'plus-monthly' },
    create: {
      name: 'Deliveryapp Plus',
      slug: 'plus-monthly',
      tagline: 'Libreng delivery at credits pabalik',
      monthlyPriceCentavos: 9900, // ₱99/month
      isActive: false, // stays off until we decide to launch
      sortOrder: 0,
    },
    update: {
      name: 'Deliveryapp Plus',
      tagline: 'Libreng delivery at credits pabalik',
      monthlyPriceCentavos: 9900,
      sortOrder: 0,
    },
  });

  // Benefits are structured records the pricing engine reads — not copy.
  const benefits = [
    {
      type: BenefitType.FREE_DELIVERY,
      displayLabel: 'Libreng delivery sa ₱299 pataas, 8x kada buwan',
      // Applies to every active service; empty means "all".
      serviceKeys: [],
      minimumOrderCentavos: 29900,
      monthlyUsageCap: 8,
      percentBasisPoints: null,
      maxDiscountCentavos: null,
      monthlyCeilingCentavos: null,
      sortOrder: 0,
    },
    {
      type: BenefitType.DISCOUNT_PERCENT,
      displayLabel: '5% off sa Kainan',
      // Scoped to food only. Scoping is data, which is why adding MART later
      // needs a row edit rather than a code change.
      serviceKeys: [ServiceKey.FOOD],
      percentBasisPoints: 500, // 5.00%
      maxDiscountCentavos: 10000, // ceiling of ₱100 per order
      minimumOrderCentavos: null,
      monthlyUsageCap: null,
      monthlyCeilingCentavos: null,
      sortOrder: 1,
    },
    {
      type: BenefitType.CREDIT_BACK_PERCENT,
      displayLabel: '2% credits pabalik, hanggang ₱200 kada buwan',
      serviceKeys: [],
      percentBasisPoints: 200, // 2.00%
      monthlyCeilingCentavos: 20000, // ₱200/month
      minimumOrderCentavos: null,
      monthlyUsageCap: null,
      maxDiscountCentavos: null,
      sortOrder: 2,
    },
  ];

  await prisma.subscriptionBenefit.deleteMany({ where: { planId: plan.id } });
  for (const benefit of benefits) {
    await prisma.subscriptionBenefit.create({ data: { ...benefit, planId: plan.id } });
  }

  console.log(`  subscription plan: ${plan.name} (isActive=${plan.isActive}), ${benefits.length} benefits`);
}

/** A couple of demo stores so the food flow and the home screen have content. */
async function seedStores() {
  const stores = [
    {
      slug: 'aling-nena-carinderia',
      name: 'Aling Nena Carinderia',
      description: 'Home-style ulam, rice meals, and merienda.',
      cityId: 'city_manila',
      addressLine: '112 Dapitan St, Sampaloc',
      latitude: 14.6152,
      longitude: 120.9899,
      preparationMinutes: 15,
      ratingAvg: 4.7,
      ratingCount: 412,
      serviceKeys: [ServiceKey.FOOD],
      menu: [
        { name: 'Adobong Manok with Rice', category: 'Rice meals', priceCentavos: 12500 },
        { name: 'Sinigang na Baboy', category: 'Rice meals', priceCentavos: 15000 },
        { name: 'Pancit Bihon (Bilao, small)', category: 'Pang-handa', priceCentavos: 35000 },
        { name: 'Extra Rice', category: 'Add-ons', priceCentavos: 2000 },
      ],
    },
    {
      slug: 'kuya-bens-grill',
      name: "Kuya Ben's Grill",
      description: 'Inihaw, isaw, and cold drinks until late.',
      cityId: 'city_quezon',
      addressLine: '48 Maginhawa St, Diliman',
      latitude: 14.6455,
      longitude: 121.0562,
      preparationMinutes: 25,
      ratingAvg: 4.5,
      ratingCount: 268,
      serviceKeys: [ServiceKey.FOOD],
      menu: [
        { name: 'Pork BBQ (3 sticks)', category: 'Inihaw', priceCentavos: 15000 },
        { name: 'Chicken Inasal', category: 'Inihaw', priceCentavos: 18000 },
        { name: 'Isaw ng Manok (5 sticks)', category: 'Inihaw', priceCentavos: 10000 },
        { name: 'Softdrinks in Can', category: 'Drinks', priceCentavos: 4500 },
      ],
    },
    {
      slug: 'sunrise-bakeshop',
      name: 'Sunrise Bakeshop',
      description: 'Pandesal from 5am, cakes to order.',
      cityId: 'city_makati',
      addressLine: '7 Bautista St, Palanan',
      latitude: 14.5541,
      longitude: 121.0084,
      preparationMinutes: 10,
      ratingAvg: 4.8,
      ratingCount: 903,
      // Already flagged for MART as well: when MART activates, this store is
      // orderable there without a data migration.
      serviceKeys: [ServiceKey.FOOD, ServiceKey.MART],
      menu: [
        { name: 'Pandesal (12 pcs)', category: 'Tinapay', priceCentavos: 6000 },
        { name: 'Ensaymada', category: 'Tinapay', priceCentavos: 3500 },
        { name: 'Ube Cheese Pandesal (6 pcs)', category: 'Tinapay', priceCentavos: 9000 },
      ],
    },
  ];

  for (const store of stores) {
    const { menu, ...storeData } = store;
    const saved = await prisma.store.upsert({
      where: { slug: store.slug },
      create: storeData,
      update: storeData,
    });
    await prisma.menuItem.deleteMany({ where: { storeId: saved.id } });
    await prisma.menuItem.createMany({
      data: menu.map((item, index) => ({
        storeId: saved.id,
        name: item.name,
        category: item.category,
        priceCentavos: item.priceCentavos,
        sortOrder: index,
      })),
    });
  }
  console.log(`  stores: ${stores.length}`);
}

async function seedPromotions() {
  const promotions = [
    {
      id: 'promo_free_delivery_launch',
      title: 'Libreng delivery ngayong linggo',
      subtitle: 'Sa unang order mo sa Kainan, ₱0 delivery fee.',
      serviceKeys: [ServiceKey.FOOD],
      cityIds: FOOD_LAUNCH_CITIES,
      sortOrder: 0,
      ctaHref: '/services/food',
    },
    {
      id: 'promo_referral',
      title: 'Mag-invite, kumita ng credits',
      subtitle: 'Get ₱50 in credits for every friend who completes their first order.',
      serviceKeys: [],
      cityIds: [],
      sortOrder: 1,
      ctaHref: '/profile/referrals',
    },
  ];

  for (const promotion of promotions) {
    await prisma.promotion.upsert({
      where: { id: promotion.id },
      create: promotion,
      update: promotion,
    });
  }
  console.log(`  promotions: ${promotions.length}`);
}

/**
 * Demo people. Note `maria`: she holds CUSTOMER and FLEET_PARTNER at once on a
 * single record, which is the identity model working as intended.
 */
async function seedUsers() {
  const juan = await prisma.user.upsert({
    where: { phone: '+639171234567' },
    create: {
      phone: '+639171234567',
      fullName: 'Juan Dela Cruz',
      displayName: 'Juan',
      roles: [UserRole.CUSTOMER],
      preferredCityId: 'city_manila',
      phoneVerifiedAt: new Date(),
    },
    update: {},
  });

  const maria = await prisma.user.upsert({
    where: { phone: '+639189876543' },
    create: {
      phone: '+639189876543',
      fullName: 'Maria Santos',
      displayName: 'Maria',
      // One person, two roles, one record.
      roles: [UserRole.CUSTOMER, UserRole.FLEET_PARTNER],
      preferredCityId: 'city_quezon',
      phoneVerifiedAt: new Date(),
    },
    update: { roles: [UserRole.CUSTOMER, UserRole.FLEET_PARTNER] },
  });

  // Credits accounts. Balances stay at zero here: the ledger is the only way to
  // move a balance, and a seed has no business writing that column directly.
  for (const user of [juan, maria]) {
    await prisma.wallet.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
    });
  }

  // A shared address book entry, marked pickup-capable so it is already usable
  // as a Padala origin the day that service activates.
  await prisma.address.upsert({
    where: { id: 'addr_juan_home' },
    create: {
      id: 'addr_juan_home',
      userId: juan.id,
      label: 'Home',
      line1: '24 Kalayaan Ave',
      barangay: 'Barangay 501',
      cityId: 'city_manila',
      province: 'Metro Manila',
      landmark: 'Green gate beside the sari-sari store',
      latitude: 14.6091,
      longitude: 120.9884,
      contactName: 'Juan Dela Cruz',
      contactPhone: '+639171234567',
      isPickupCapable: true,
      isDefault: true,
    },
    update: {},
  });

  // Maria's fleet record. Approved for FOOD only — explicitly NOT for RIDE,
  // which is the per-service verification model saying so out loud.
  const fleetPartner = await prisma.fleetPartner.upsert({
    where: { userId: maria.id },
    create: {
      userId: maria.id,
      vehicleType: VehicleType.MOTORCYCLE,
      vehiclePlate: 'NCR-1234',
      vehicleModel: 'Honda Click 125i',
      equipment: ['insulated_bag'],
      homeCityId: 'city_quezon',
      isOnline: false,
      ratingAvg: 4.9,
      ratingCount: 156,
      completedOrderCount: 162,
      acceptanceRate: 0.94,
      currentLatitude: 14.6455,
      currentLongitude: 121.0562,
      enabledServices: [ServiceKey.FOOD],
    },
    update: { enabledServices: [ServiceKey.FOOD] },
  });

  const verifications = [
    { serviceType: ServiceKey.FOOD, status: VerificationStatus.APPROVED, submittedDocuments: ['drivers_licence', 'nbi_clearance', 'food_handler_card'] },
    // Applied for passengers, not yet approved. A food approval grants nothing
    // here, which is the whole reason this table exists.
    { serviceType: ServiceKey.RIDE, status: VerificationStatus.PENDING, submittedDocuments: ['professional_drivers_licence'] },
    { serviceType: ServiceKey.MART, status: VerificationStatus.NOT_SUBMITTED, submittedDocuments: [] },
    { serviceType: ServiceKey.PARCEL, status: VerificationStatus.NOT_SUBMITTED, submittedDocuments: [] },
    { serviceType: ServiceKey.PABILI, status: VerificationStatus.NOT_SUBMITTED, submittedDocuments: [] },
  ];

  for (const verification of verifications) {
    await prisma.fleetPartnerServiceVerification.upsert({
      where: {
        fleetPartnerId_serviceType: {
          fleetPartnerId: fleetPartner.id,
          serviceType: verification.serviceType,
        },
      },
      create: {
        fleetPartnerId: fleetPartner.id,
        ...verification,
        submittedAt: verification.status === VerificationStatus.NOT_SUBMITTED ? null : new Date(),
        decidedAt: verification.status === VerificationStatus.APPROVED ? new Date() : null,
      },
      update: { status: verification.status },
    });
  }

  console.log(`  users: 2 (maria holds ${maria.roles.length} roles), fleet partners: 1`);
}

async function main() {
  console.log('Seeding Deliveryapp...');
  await seedCities();
  await seedServices();
  await seedStores();
  await seedFaq();
  await seedSubscriptionPlan();
  await seedPromotions();
  await seedUsers();
  console.log('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
