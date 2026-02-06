#!/bin/bash

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <todo_file> <iterations>"
  exit 1
fi

TODO_FILE="$1"
ITERATIONS="$2"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
PROGRESS_FILE="progress.txt"

echo "Using input file: $TODO_FILE"
echo "Progress will be logged to: $PROGRESS_FILE"

for ((i=1; i<=$ITERATIONS; i++)); do
  echo "=== Starting iteration $i ==="

  if ! result=$(claude --dangerously-skip-permissions -p "@${TODO_FILE} @${PROGRESS_FILE} \
  1. Find the next task to do and implement it. \
  2. Run your tests and type checks. \
  3. Mark done items in ${TODO_FILE}. \
  4. Append your progress to ${PROGRESS_FILE}. \
  5. Commit your changes. \
  ONLY WORK ON A SINGLE TASK. \
  If all work in ${TODO_FILE} is complete, output <promise>COMPLETE</promise>." 2>&1); then
    echo "Claude command failed with exit code $?"
    echo "Output: $result"
    exit 1
  fi

  echo "$result"

  if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
    echo "All tasks complete after $i iterations."
    exit 0
  fi
done
