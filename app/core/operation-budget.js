/** Logical operation deadline. It never abandons or cancels an in-flight USB request. */
export class OperationBudget {
  constructor(label, timeoutMs, onStage = null){
    this.label = label; this.deadline = performance.now() + timeoutMs; this.onStage = onStage;
  }
  check(stage){
    if (stage !== this.stage){ this.stage = stage; this.onStage?.(`${this.label}：${stage}`); }
    const left = this.deadline - performance.now();
    if (left <= 0){
      const error = new Error(`${this.label}已达到总等待预算（阶段：${this.stage}）；未继续发起新请求`);
      error.code = 'OPERATION_TIMEOUT'; throw error;
    }
    return left;
  }
  async step(stage, fn){
    const result = await fn(this.check(stage));
    this.check(stage);
    return result;
  }
}
