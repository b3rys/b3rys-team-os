/** Sends mid-turn inputs for one conversation one at a time, in arrival order. */
export function createSteerQueue() {
  const steering = new Map<number, Promise<void>>();
  return {
    async steer(chatId: number, text: string, send: (body: string) => Promise<boolean>): Promise<boolean> {
      const task = (steering.get(chatId) ?? Promise.resolve()).then(() => send(text));
      const settled = task.then(() => {}, () => {});
      steering.set(chatId, settled);
      void settled.then(() => { if (steering.get(chatId) === settled) steering.delete(chatId); });
      return task;
    },
  };
}
export type SteerQueue = ReturnType<typeof createSteerQueue>;
