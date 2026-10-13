/** L2-regularised logistic regression by batch gradient descent on standardised features. */
export interface LogRegFit {
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
}

export function fitLogReg(X: number[][], y: number[], o: { l2: number; iters: number; lr: number }): LogRegFit {
  if (X.length !== y.length || X.length === 0) throw new Error(`rows: ${X.length} features vs ${y.length} labels`);
  const d = X[0]!.length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j]!, 0) / X.length);
  const std = mean.map((m, j) => Math.sqrt(X.reduce((s, r) => s + (r[j]! - m) ** 2, 0) / X.length) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]!) / std[j]!));
  const w = Array<number>(d).fill(0);
  let b = 0;
  for (let it = 0; it < o.iters; it++) {
    const gw = Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const p = 1 / (1 + Math.exp(-(b + Z[i]!.reduce((s, v, j) => s + v * w[j]!, 0))));
      const e = p - y[i]!;
      gb += e;
      for (let j = 0; j < d; j++) gw[j]! += e * Z[i]![j]!;
    }
    b -= (o.lr * gb) / Z.length;
    for (let j = 0; j < d; j++) w[j] = w[j]! - o.lr * (gw[j]! / Z.length + o.l2 * w[j]!);
  }
  return { mean, std, weights: w, bias: b };
}
