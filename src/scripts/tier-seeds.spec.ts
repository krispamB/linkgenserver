import { TIER_SEEDS } from '.';

describe('TIER_SEEDS', () => {
  it('should seed the credit allowance ladder for every tier', () => {
    expect(
      Object.fromEntries(
        TIER_SEEDS.map(({ name, limits }) => [name, limits.credits]),
      ),
    ).toEqual({
      Free: 0,
      Starter: 2000,
      Creator: 10000,
      'Pro Writer': -1,
    });
  });
});
