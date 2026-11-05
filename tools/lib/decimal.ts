// Exact decimal numbers for KiCad coordinates, with the text of Python's decimal.Decimal. A pose or a pad shape goes
// into a hash as this text, so 1.50 and 1.5 stay different until normalize(). No rounding: board values stay far
// under Python's 28 digits.
export class Decimal {
  readonly digits: bigint;
  readonly exponent: number;
  readonly negative: boolean;

  private constructor(digits: bigint, exponent: number, negative: boolean) {
    this.digits = digits;
    this.exponent = exponent;
    this.negative = negative;
  }

  /** null for NaN and the infinities, which a board value may not be. */
  static parse(text: string): Decimal | null {
    const value = text.trim().replaceAll('_', '');
    if (/^[+-]?(inf(inity)?|s?nan\d*)$/i.test(value)) return null;
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!match || !`${match[2]}${match[3] ?? ''}`) throw new Error("[<class 'decimal.ConversionSyntax'>]");
    const fraction = match[3] ?? '';
    return new Decimal(BigInt(`${match[2]}${fraction}`), Number(match[4] ?? 0) - fraction.length, match[1] === '-');
  }

  static of(text: string): Decimal {
    const value = Decimal.parse(text);
    if (!value) throw new Error('nonfinite decimal: ' + text);
    return value;
  }

  private get signed(): bigint { return this.negative ? -this.digits : this.digits; }

  private scaled(exponent: number): bigint { return this.signed * 10n ** BigInt(this.exponent - exponent); }

  private static fromSigned(value: bigint, exponent: number, negativeZero = false): Decimal {
    return new Decimal(value < 0n ? -value : value, exponent, value < 0n || (value === 0n && negativeZero));
  }

  get isZero(): boolean { return this.digits === 0n; }

  add(other: Decimal): Decimal {
    const exponent = Math.min(this.exponent, other.exponent);
    return Decimal.fromSigned(this.scaled(exponent) + other.scaled(exponent), exponent, this.negative && other.negative);
  }

  /** Unary minus: Python gives zero a plus sign here, but not in a subtraction. */
  neg(): Decimal { return new Decimal(this.digits, this.exponent, !this.isZero && !this.negative); }

  sub(other: Decimal): Decimal { return this.add(new Decimal(other.digits, other.exponent, !other.negative)); }

  /** Exact, and the exponents add: 10 x 1E-6 is 0.000010, not 0.00001. */
  mul(other: Decimal): Decimal {
    return new Decimal(this.digits * other.digits, this.exponent + other.exponent, this.negative !== other.negative);
  }

  /** Python's Decimal %: the sign of the dividend, unlike % on a float. */
  mod(other: Decimal): Decimal {
    const exponent = Math.min(this.exponent, other.exponent);
    return Decimal.fromSigned(this.scaled(exponent) % other.scaled(exponent), exponent, this.negative);
  }

  compare(other: Decimal): number {
    const exponent = Math.min(this.exponent, other.exponent);
    const a = this.scaled(exponent), b = other.scaled(exponent);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  equals(other: Decimal): boolean { return this.compare(other) === 0; }

  normalize(): Decimal {
    if (this.isZero) return new Decimal(0n, 0, this.negative);
    let digits = this.digits, exponent = this.exponent;
    while (digits % 10n === 0n) {
      digits /= 10n;
      exponent++;
    }
    return new Decimal(digits, exponent, this.negative);
  }

  toNumber(): number { return Number(this.toString()); }

  /** str(Decimal): plain notation unless the exponent is positive or the value is tiny. */
  toString(): string {
    const digits = this.digits.toString();
    const left = this.exponent + digits.length;
    const dot = this.exponent <= 0 && left > -6 ? left : 1;
    let text: string;
    if (dot <= 0) text = `0.${'0'.repeat(-dot)}${digits}`;
    else if (dot >= digits.length) text = digits + '0'.repeat(dot - digits.length);
    else text = `${digits.slice(0, dot)}.${digits.slice(dot)}`;
    const power = left - dot;
    return `${this.negative ? '-' : ''}${text}${power ? `E${power > 0 ? '+' : ''}${power}` : ''}`;
  }
}

/** The (x % 360 + 360) % 360 of an angle in degrees. */
export const positiveDegrees = (angle: Decimal): Decimal => {
  const full = Decimal.of('360');
  return angle.mod(full).add(full).mod(full);
};
