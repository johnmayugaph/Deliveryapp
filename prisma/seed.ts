import {
  BenefitType,
  FulfilmentType,
  IntentGroup,
  PrismaClient,
  ServiceKey,
  StoreRole,
  SupportTicketPriority,
  SupportTicketStatus,
  UserRole,
  VehicleType,
  VerificationStatus,
} from '@prisma/client';
import { describeDatabaseHost, seedRefusalReason } from '../src/lib/demo/policy';
import { inviteExpiry } from '../src/lib/merchant/staff-policy';

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
    displayName: 'Food',
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
    displayName: 'Mart',
    tagline: 'Groceries and sari-sari',
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
    displayName: 'Parcel',
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
    displayName: 'Errands',
    tagline: 'We buy it for you',
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
    displayName: 'Rides',
    tagline: 'Motorcycle or car',
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
      title: 'Account and app',
      serviceType: null,
      sortOrder: 0,
      articles: [
        {
          question: 'How do I change my delivery address?',
          answer:
            'Tap the location at the top of the home screen. Your saved addresses are shared across every service, so an address you save for food is ready for a parcel pickup too.',
        },
        {
          question: 'Can I be a rider and a customer on one account?',
          answer:
            'Yes. One account holds both roles. Switch between ordering and accepting jobs from your Profile.',
        },
      ],
    },
    {
      slug: 'food-orders',
      title: 'Food',
      serviceType: ServiceKey.FOOD,
      sortOrder: 10,
      articles: [
        {
          question: 'Why has the store not accepted my order yet?',
          answer:
            'Restaurants confirm orders themselves. If nobody confirms within a few minutes we cancel and return anything you paid to your Credits.',
        },
        {
          question: 'Can I cancel an order?',
          answer:
            'You can cancel any time before the store starts preparing. After that, message us from the order and we will sort it out.',
        },
      ],
    },
    {
      slug: 'credits-rewards',
      title: 'Credits and rewards',
      serviceType: null,
      sortOrder: 20,
      articles: [
        {
          question: 'What are Credits?',
          answer:
            'Credits are rewards we give you — promos, referral bonuses, and refunds. You spend them on orders inside the app.',
        },
        {
          question: 'Can I load Credits or withdraw them?',
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
      name: 'TARA Plus',
      slug: 'plus-monthly',
      tagline: 'Free delivery and credits back',
      monthlyPriceCentavos: 9900, // ₱99/month
      isActive: false, // stays off until we decide to launch
      sortOrder: 0,
    },
    update: {
      name: 'TARA Plus',
      tagline: 'Free delivery and credits back',
      monthlyPriceCentavos: 9900,
      sortOrder: 0,
    },
  });

  // Benefits are structured records the pricing engine reads — not copy.
  const benefits = [
    {
      type: BenefitType.FREE_DELIVERY,
      displayLabel: 'Free delivery over ₱299, 8x a month',
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
      displayLabel: '5% off Food',
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
      displayLabel: '2% back in credits, up to ₱200 a month',
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
/**
 * Delivery rates. In the database rather than in code because ops will want to
 * tune these without waiting for a deploy.
 *
 * A fallback row (cityId: null) plus a Manila-specific row, so the
 * city-beats-fallback resolution has something real to resolve.
 */
async function seedDeliveryFeeRules() {
  const rules: {
    serviceType: ServiceKey;
    cityId: string | null;
    baseFeeCentavos: number;
    includedMeters: number;
    perKilometreCentavos: number;
    minimumFeeCentavos: number;
    maximumFeeCentavos: number | null;
    freeAboveSubtotalCentavos: number | null;
    smallOrderThresholdCentavos: number | null;
    smallOrderFeeCentavos: number;
    serviceFeeCentavos: number;
  }[] = [
    {
      serviceType: ServiceKey.FOOD,
      cityId: null, // fallback for every city where FOOD is live
      baseFeeCentavos: 4900, // ₱49 up to 2km
      includedMeters: 2000,
      perKilometreCentavos: 1200, // ₱12/km beyond that, pro rata
      minimumFeeCentavos: 4900,
      maximumFeeCentavos: 25000, // ₱250 ceiling
      freeAboveSubtotalCentavos: null,
      smallOrderThresholdCentavos: 15000, // below ₱150
      smallOrderFeeCentavos: 2000, // ₱20
      serviceFeeCentavos: 1000, // ₱10
    },
    {
      serviceType: ServiceKey.FOOD,
      cityId: 'city_manila', // denser, shorter trips
      baseFeeCentavos: 3900,
      includedMeters: 2000,
      perKilometreCentavos: 1000,
      minimumFeeCentavos: 3900,
      maximumFeeCentavos: 20000,
      freeAboveSubtotalCentavos: 100000, // free over ₱1,000, for everybody
      smallOrderThresholdCentavos: 15000,
      smallOrderFeeCentavos: 2000,
      serviceFeeCentavos: 1000,
    },
  ];

  for (const rule of rules) {
    // `upsert` cannot target the fallback row: Postgres treats NULL cityIds as
    // distinct, so the compound unique key does not match one. Uniqueness of
    // the fallback is enforced by a partial index in
    // prisma/sql/delivery_fee_rules.sql.
    const existing = await prisma.deliveryFeeRule.findFirst({
      where: { serviceType: rule.serviceType, cityId: rule.cityId },
      select: { id: true },
    });
    if (existing) {
      await prisma.deliveryFeeRule.update({ where: { id: existing.id }, data: rule });
    } else {
      await prisma.deliveryFeeRule.create({ data: rule });
    }
  }
  console.log(`  delivery fee rules: ${rules.length}`);
}

/**
 * NOTE ON RATINGS. These shops deliberately have NO rating.
 *
 * They used to be seeded with invented averages — "4.7 from 412 reviews" —
 * which was harmless while nothing wrote ratings and is not any more:
 * `Store.ratingAvg` is now DERIVED from `OrderReview`, so a seeded aggregate is
 * a number no review supports. `npm run db:ratings-recompute` zeroes it and
 * reports it as drift, which is exactly right.
 *
 * So the demo storefront shows "New", which is true. To see a real rating
 * appear: place an order, walk it to COMPLETED, and rate it from the order
 * screen.
 */
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
      serviceKeys: [ServiceKey.FOOD],
      menu: [
        { name: 'Adobong Manok with Rice', category: 'Rice meals', priceCentavos: 12500 },
        { name: 'Sinigang na Baboy', category: 'Rice meals', priceCentavos: 15000 },
        { name: 'Pancit Bihon (Bilao, small)', category: 'Party trays', priceCentavos: 35000 },
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
      serviceKeys: [ServiceKey.FOOD],
      menu: [
        { name: 'Pork BBQ (3 sticks)', category: 'Grilled', priceCentavos: 15000 },
        { name: 'Chicken Inasal', category: 'Grilled', priceCentavos: 18000 },
        { name: 'Isaw ng Manok (5 sticks)', category: 'Grilled', priceCentavos: 10000 },
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
      // Already flagged for MART as well: when MART activates, this store is
      // orderable there without a data migration.
      serviceKeys: [ServiceKey.FOOD, ServiceKey.MART],
      menu: [
        { name: 'Pandesal (12 pcs)', category: 'Bread', priceCentavos: 6000 },
        { name: 'Ensaymada', category: 'Bread', priceCentavos: 3500 },
        { name: 'Ube Cheese Pandesal (6 pcs)', category: 'Bread', priceCentavos: 9000 },
      ],
    },
  ];

  for (const store of stores) {
    const { menu, ...storeData } = store;
    // `isDemo` is set here rather than in each literal above so that a store
    // added to this file cannot be forgotten: everything the seed writes is
    // demo data by definition, and `npm run db:purge-demo` finds it by this
    // column alone.
    const demoStore = { ...storeData, isDemo: true };
    const saved = await prisma.store.upsert({
      where: { slug: store.slug },
      create: demoStore,
      update: demoStore,
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

/**
 * Merchant accounts.
 *
 * Nena owns one store; Ben owns two, which is what exercises the store picker
 * and stops the merchant screens quietly assuming a single store. Rosa is STAFF
 * at Nena's place: she works the queue but cannot change prices.
 */
async function seedMerchants() {
  const merchants = [
    {
      phone: '+639170001111',
      fullName: 'Nena Bautista',
      displayName: 'Nena',
      cityId: 'city_manila',
      stores: [{ slug: 'aling-nena-carinderia', role: StoreRole.OWNER }],
    },
    {
      phone: '+639170002222',
      fullName: 'Ben Ocampo',
      displayName: 'Ben',
      cityId: 'city_quezon',
      stores: [
        { slug: 'kuya-bens-grill', role: StoreRole.OWNER },
        { slug: 'sunrise-bakeshop', role: StoreRole.OWNER },
      ],
    },
    {
      phone: '+639170003333',
      fullName: 'Rosa Lim',
      displayName: 'Rosa',
      cityId: 'city_manila',
      stores: [{ slug: 'aling-nena-carinderia', role: StoreRole.STAFF }],
    },
  ];

  for (const merchant of merchants) {
    const { stores, cityId, ...person } = merchant;
    const user = await prisma.user.upsert({
      where: { phone: merchant.phone },
      create: {
        ...person,
        roles: [UserRole.CUSTOMER, UserRole.MERCHANT_OWNER],
        preferredCityId: cityId,
        phoneVerifiedAt: new Date(),
        onboardedAt: new Date(),
        isDemo: true,
      },
      update: {
        fullName: person.fullName,
        roles: [UserRole.CUSTOMER, UserRole.MERCHANT_OWNER],
        onboardedAt: new Date(),
        // Re-asserted on update so that a database seeded before this column
        // existed is marked the first time the seed is run again.
        isDemo: true,
      },
    });

    for (const membership of stores) {
      const store = await prisma.store.findUniqueOrThrow({
        where: { slug: membership.slug },
        select: { id: true },
      });
      await prisma.storeMember.upsert({
        where: { storeId_userId: { storeId: store.id, userId: user.id } },
        create: { storeId: store.id, userId: user.id, role: membership.role },
        update: { role: membership.role },
      });
    }
  }

  const total = merchants.reduce((count, m) => count + m.stores.length, 0);
  console.log(`  merchants: ${merchants.length} across ${total} store membership(s)`);
}

async function seedPromotions() {
  const promotions = [
    {
      id: 'promo_free_delivery_launch',
      title: 'Free delivery this week',
      subtitle: 'No delivery fee on your first Food order.',
      serviceKeys: [ServiceKey.FOOD],
      cityIds: FOOD_LAUNCH_CITIES,
      sortOrder: 0,
      ctaHref: '/services/food',
    },
    {
      id: 'promo_referral',
      title: 'Invite a friend, earn credits',
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
      onboardedAt: new Date(),
      isDemo: true,
    },
    update: { fullName: 'Juan Dela Cruz', onboardedAt: new Date(), isDemo: true },
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
      onboardedAt: new Date(),
      isDemo: true,
    },
    update: {
      roles: [UserRole.CUSTOMER, UserRole.FLEET_PARTNER],
      fullName: 'Maria Santos',
      onboardedAt: new Date(),
      isDemo: true,
    },
  });

  // An operations account, for development only.
  //
  // Two things in the app require a named human rather than "the system": a
  // ledger ADJUSTMENT, and granting a subscription. Both constraints are
  // enforced in SQL, so without an account holding one of these roles neither
  // is possible at all.
  //
  // It is also the most dangerous row this file writes. 0917 000 9999 is a
  // real Philippine number format and somebody owns it; on a production
  // deployment they could request a login code for an administrator account
  // they did nothing to earn. `isDemo` is what stops that — a demo account
  // cannot hold a session in production at all — and the real first
  // administrator is made with `npm run admin:grant`, on a number the operator
  // controls.
  const ops = await prisma.user.upsert({
    where: { phone: '+639170009999' },
    create: {
      phone: '+639170009999',
      fullName: 'Ops Admin',
      displayName: 'Ops',
      roles: [UserRole.ADMIN, UserRole.SUPPORT_AGENT],
      preferredCityId: 'city_manila',
      phoneVerifiedAt: new Date(),
      onboardedAt: new Date(),
      isDemo: true,
    },
    update: { roles: [UserRole.ADMIN, UserRole.SUPPORT_AGENT], isDemo: true },
  });

  // Two support threads, so both halves of the support screens have something
  // real in them: one waiting in the queue for the operator to answer, and one
  // already answered so the customer's side shows what a reply looks like.
  //
  // Written directly rather than through `createSupportTicket`, on purpose: a
  // seed has no business enqueueing notifications to every administrator. Both
  // hang off demo accounts, so `db:purge-demo` takes them with the accounts.
  await prisma.supportTicket.upsert({
    where: { id: 'tkt_demo_waiting' },
    create: {
      id: 'tkt_demo_waiting',
      ticketNumber: 'HELP-DEMO-00001',
      userId: juan.id,
      subject: 'Rider marked my order delivered but nothing arrived',
      body:
        'The app says delivered at 7:42pm but nobody came to the gate. ' +
        'I waited outside for twenty minutes. Can you check with the rider?',
      status: SupportTicketStatus.OPEN,
      priority: SupportTicketPriority.HIGH,
    },
    update: {},
  });

  const answered = await prisma.supportTicket.upsert({
    where: { id: 'tkt_demo_answered' },
    create: {
      id: 'tkt_demo_answered',
      ticketNumber: 'HELP-DEMO-00002',
      userId: maria.id,
      subject: 'Credits did not arrive after my order',
      body: 'I finished an order yesterday and the credit-back never showed up.',
      status: SupportTicketStatus.AWAITING_CUSTOMER,
      priority: SupportTicketPriority.NORMAL,
      firstRespondedAt: new Date(),
      assignedAgentId: ops.id,
    },
    update: {},
  });

  await prisma.supportTicketMessage.upsert({
    where: { id: 'tktmsg_demo_reply' },
    create: {
      id: 'tktmsg_demo_reply',
      ticketId: answered.id,
      authorUserId: ops.id,
      isFromSupport: true,
      body:
        'Found it — the credit-back lands when the order completes, and yours ' +
        'was still marked in transit. It is on your balance now. Anything else?',
    },
    update: {},
  });

  // One invitation nobody has taken up, so the "waiting to sign in" half of the
  // staff screen has something in it. The number is deliberately one that no
  // seeded account uses: the whole point of an invite is that there is no
  // account yet, and it becomes real access the first time that number signs
  // in. Nothing was texted to it — see `lib/merchant/staff.ts`.
  const carinderia = await prisma.store.findUnique({
    where: { slug: 'aling-nena-carinderia' },
    select: { id: true },
  });
  if (carinderia) {
    await prisma.storeInvite.upsert({
      where: { storeId_phone: { storeId: carinderia.id, phone: '+639175550123' } },
      create: {
        storeId: carinderia.id,
        phone: '+639175550123',
        role: StoreRole.STAFF,
        invitedById: ops.id,
        expiresAt: inviteExpiry(),
      },
      update: {},
    });
  }

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

  console.log(
    `  users: 3 (maria holds ${maria.roles.length} roles, plus an ops admin), ` +
      'fleet partners: 1, support threads: 2, one staff invitation waiting',
  );
}

/**
 * Refuses to write demo data anywhere it was not clearly asked to.
 *
 * The mistake this catches is not a careless one — it is running
 * `npm run db:seed` in a terminal that happens to have a production
 * DATABASE_URL exported, which is a thing that happens to careful people on a
 * Friday. What lands if it succeeds is six accounts on real Philippine number
 * formats, one of them an administrator, and four restaurants with invented
 * prices that a real customer can order from.
 *
 * `--force` exists because a check with no way past it gets deleted rather
 * than respected, and because filling a staging database with demo data on
 * purpose is legitimate.
 */
function assertSeedTargetIsAllowed(): void {
  const force = process.argv.slice(2).includes('--force');
  const refusal = seedRefusalReason({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    force,
  });
  if (refusal === null) return;

  console.error('');
  console.error('  Refusing to seed.');
  console.error('');
  console.error(`  ${refusal}`);
  console.error('');
  console.error('  If you meant it:  npm run db:seed -- --force');
  console.error('');
  process.exit(2);
}

async function main() {
  assertSeedTargetIsAllowed();
  console.log(`Seeding TARA into ${describeDatabaseHost(process.env.DATABASE_URL)}...`);
  await seedCities();
  await seedServices();
  await seedDeliveryFeeRules();
  await seedStores();
  await seedFaq();
  await seedSubscriptionPlan();
  await seedMerchants();
  await seedPromotions();
  await seedUsers();
  console.log('Done.');
  console.log('');
  console.log('  Everything above is DEMO data, marked isDemo in the database.');
  console.log('  Before this deployment is reachable by anybody:');
  console.log('    npm run db:purge-demo            # see what would go');
  console.log('    npm run db:purge-demo -- --confirm');
  console.log('    npm run admin:grant -- 09XXXXXXXXX --reason "..."');
  console.log('');
  console.log('  Shops start with no rating, because ratings are derived from');
  console.log('  real reviews now. Complete an order and rate it to see one.');
  console.log('');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
