import { describe, expect, it } from 'vitest';
import { calculateCredit, estimateTokens } from '../src/utils';
describe('credit engine',()=>{it('calculates integer credit',()=>{expect(calculateCredit(1_000_000,500_000,0,100,200,0,0)).toBe(200)});it('estimates positive tokens',()=>{expect(estimateTokens([{content:'hello'}])).toBeGreaterThan(0)})});
