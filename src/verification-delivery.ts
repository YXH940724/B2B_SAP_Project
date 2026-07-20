export interface VerificationDelivery {
  send(customer: string, code: string): Promise<void>;
}

type Logger = (line: string) => void;

export function createVerificationDelivery(env: NodeJS.ProcessEnv, logger: Logger = (line) => console.info(line)): VerificationDelivery {
  if (env.VERIFICATION_DELIVERY !== "log") throw new Error("No verification delivery is configured.");
  if (env.NODE_ENV !== "development") throw new Error("Log verification delivery is not allowed in production.");
  return { send: async (customer, code) => logger(`[development] verification code for ${customer}: ${code}`) };
}
