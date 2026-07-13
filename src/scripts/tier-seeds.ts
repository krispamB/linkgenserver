import { Feature } from '../database/schemas/tier.schema';

export type TierSeed = {
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  paddleMonthlyPriceId?: string;
  paddleYearlyPriceId?: string;
  isDefault: boolean;
  isActive: boolean;
  limits: Record<Feature, number>;
  metadata: {
    features: string[];
  };
};

export const TIER_SEEDS: TierSeed[] = [
  {
    name: 'Free',
    monthlyPrice: 0,
    yearlyPrice: 0,
    paddleMonthlyPriceId: undefined,
    paddleYearlyPriceId: undefined,
    isDefault: true,
    isActive: true,
    limits: {
      credits: 0,
      research: 0,
      connected_accounts: 1,
      scheduled_posts: 1,
    },
    metadata: {
      features: ['1 connected account', '1 scheduled post', '30 day history'],
    },
  },
  {
    name: 'Starter',
    monthlyPrice: 9.99,
    yearlyPrice: 0,
    paddleMonthlyPriceId: 'pri_01kp1mjq33h66h0sgwjy1sshzb',
    paddleYearlyPriceId: undefined,
    isDefault: false,
    isActive: true,
    limits: {
      credits: 2000,
      research: 1,
      connected_accounts: 1,
      scheduled_posts: 5,
    },
    metadata: {
      features: [
        'AI research',
        '1 connected account',
        '5 scheduled posts',
        '90 day history',
      ],
    },
  },
  {
    name: 'Creator',
    monthlyPrice: 19.99,
    yearlyPrice: 0,
    paddleMonthlyPriceId: 'pri_01kp1mgt8gmsnzb4cb9jndz34k',
    paddleYearlyPriceId: undefined,
    isDefault: false,
    isActive: true,
    limits: {
      credits: 10000,
      research: 1,
      connected_accounts: 1,
      scheduled_posts: 15,
    },
    metadata: {
      features: [
        'AI research',
        '1 connected account',
        '15 scheduled posts',
        '1 year post history',
      ],
    },
  },
  {
    name: 'Pro Writer',
    monthlyPrice: 29.99,
    yearlyPrice: 0,
    paddleMonthlyPriceId: 'pri_01kp1mmw9b31vxjvhs69y1q4g3',
    paddleYearlyPriceId: undefined,
    isDefault: false,
    isActive: true,
    limits: {
      credits: -1,
      research: 1,
      connected_accounts: 5,
      scheduled_posts: -1,
    },
    metadata: {
      features: [
        'AI research',
        '10 connected accounts',
        'unlimited scheduled posts',
        'unlimited post history',
      ],
    },
  },
];
