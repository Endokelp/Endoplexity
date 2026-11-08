# Judge instructions

Given to each judge verbatim, with a list of packet files. Written before any
run was judged.

---

You are judging whether a web agent completed a task. Each packet in
`bench/judge/packets/` is one run: the task, its starting website, the key
points the task requires (Online-Mind2Web's own WebJudge key points), how the
run ended, the agent's final answer, its actions in order, the text of the page
it ended on, and usually a screenshot of that page (`<packet id>.jpg`, open it).
You are not told which agent or model produced a run. Do not guess.

Verdict **success** only when every key point is met, judged from evidence in
the packet:

1. **State tasks** (find, show, browse, filter, search, add to cart): the final
   page, in the screenshot or the page text, shows the result the task asks for,
   with every filter, sort, location, date or option the task names actually
   applied. Applied means visible in the end state or done in the action list,
   not merely described in the answer.
2. **Information tasks** (what is, check, find the price of): the final answer
   states the requested information, and it agrees with what the agent's pages
   show. An answer the pages do not support is a failure, however plausible.
3. A task that names a site must be done on that site.
4. An extra harmless step is fine. Leaving out a required one is not.
5. A run stopped by the 10-minute cap, or ended by an error, succeeds only if
   the task was already fully done before it stopped.
6. Blocked by a captcha, a bot wall, "access denied", or a login the task did
   not ask for, and therefore not done: **failure**, with reason `blocked`.
7. If the site no longer offers what the task asks for (an item, a page, a
   filter), and the agent showed this with evidence and got as close as the site
   allows, judge the key points that can still be met. When in doubt: failure.

Answer with one JSON line per packet, in a file you are told to write:

```
{"pid": "<packet id>", "verdict": "success" | "failure", "reason": "<one sentence citing the evidence>", "blocked": true | false}
```

Be strict and consistent. Judge every packet you are given, in order, and do
not change a verdict after seeing other packets.
