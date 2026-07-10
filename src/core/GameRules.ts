export class Economy {
  constructor(public balance = 750) {}
  earn(amount: number): number {
    if (amount < 0) throw new Error('Reward cannot be negative');
    this.balance += Math.round(amount);
    return this.balance;
  }
  spend(amount: number): boolean {
    if (amount < 0 || amount > this.balance) return false;
    this.balance -= Math.round(amount);
    return true;
  }
}

export function calculateDamage(base: number, distance: number, armour = 0): number {
  const falloff = Math.max(0.35, 1 - Math.max(0, distance - 15) / 100);
  return Math.max(0, Math.round(base * falloff - armour * 0.45));
}
