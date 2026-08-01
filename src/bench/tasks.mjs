// A small, Terminal-Bench-style coding suite. Each task gives the agent an instruction and a sandbox;
// after the agent stops, `verify` runs in the same sandbox and exit 0 means pass. Tasks are written
// so a correct solution is unambiguous and the verifier is objective (run the code, check the output).
// This is the built-in suite for local validation; point the runner at real Terminal-Bench tasks
// (see terminal-bench.md) for the published comparison.
export const CODING_TASKS = [
  {
    id: "fizzbuzz",
    instruction: "Write a Python file solution.py that, when run with `python3 solution.py`, prints the numbers 1 to 15 one per line, but prints 'Fizz' for multiples of 3, 'Buzz' for multiples of 5, and 'FizzBuzz' for multiples of 15.",
    setup: async () => {},
    verify: "python3 solution.py > out.txt && [ \"$(sed -n '3p' out.txt)\" = Fizz ] && [ \"$(sed -n '5p' out.txt)\" = Buzz ] && [ \"$(sed -n '15p' out.txt)\" = FizzBuzz ] && [ \"$(sed -n '1p' out.txt)\" = 1 ]",
  },
  {
    id: "palindrome",
    instruction: "Create solution.py defining a function is_palindrome(s) that returns True if s reads the same forwards and backwards ignoring case and non-alphanumeric characters, else False. Do not print anything.",
    setup: async () => {},
    verify: "python3 -c \"import solution as s; assert s.is_palindrome('A man, a plan, a canal: Panama'); assert not s.is_palindrome('hello'); assert s.is_palindrome('RaceCar'); print('ok')\"",
  },
  {
    id: "fix-bug",
    instruction: "buggy.py is supposed to print the sum of the first 10 positive integers (55) but it prints the wrong number. Fix buggy.py so `python3 buggy.py` prints exactly 55.",
    setup: async (ex) => { await ex.write("buggy.py", "total = 0\nfor i in range(10):\n    total += i\nprint(total)\n"); },
    verify: "[ \"$(python3 buggy.py)\" = 55 ]",
  },
];
