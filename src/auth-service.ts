import { generateVerificationCode, hashSecret, verifySecret } from "./auth-crypto.js";
import type { AuthStore } from "./auth-store.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const REQUEST_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS = 3;

export class RegistrationError extends Error {
  constructor(message: string) { super(message); this.name = "RegistrationError"; }
}

export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly now: () => number = () => Date.now(),
    private readonly createCode: () => string = generateVerificationCode,
  ) {}

  async requestCode(customer: string): Promise<{ code: string }> {
    if (this.store.getUser(customer)) throw new RegistrationError("该客户号已注册，请直接登录。");
    const now = this.now();
    const previous = this.store.getVerification(customer);
    const inWindow = previous && now - previous.requestWindowStartedAt < REQUEST_WINDOW_MS;
    if (inWindow && previous.requestCount >= MAX_REQUESTS) throw new RegistrationError("验证码请求过于频繁，请稍后再试。");
    const code = this.createCode();
    this.store.saveVerification({
      customer,
      codeHash: await hashSecret(code),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      requestCount: inWindow ? previous.requestCount + 1 : 1,
      requestWindowStartedAt: inWindow ? previous.requestWindowStartedAt : now,
    });
    return { code };
  }

  async completeRegistration(customer: string, code: string, password: string): Promise<void> {
    if (password.length < 12) throw new RegistrationError("密码至少需要 12 位。");
    if (this.store.getUser(customer)) throw new RegistrationError("该客户号已注册，请直接登录。");
    const record = this.store.getVerification(customer);
    if (!record) throw new RegistrationError("验证码不存在，请重新获取。");
    if (record.expiresAt <= this.now()) {
      this.store.deleteVerification(customer);
      throw new RegistrationError("验证码已过期，请重新获取。");
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      this.store.deleteVerification(customer);
      throw new RegistrationError("验证码错误次数过多，请重新获取。");
    }
    if (!(await verifySecret(code, record.codeHash))) {
      this.store.updateAttempts(customer, record.attempts + 1);
      throw new RegistrationError("验证码不正确。");
    }
    this.store.createUser(customer, await hashSecret(password), this.now());
    this.store.deleteVerification(customer);
  }

  async login(customer: string, password: string): Promise<boolean> {
    const user = this.store.getUser(customer);
    if (!user || !(await verifySecret(password, user.passwordHash))) return false;
    this.store.markLogin(customer, this.now());
    return true;
  }
}
