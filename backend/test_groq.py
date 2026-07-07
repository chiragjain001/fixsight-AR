import os
from groq import Groq
from dotenv import load_dotenv

def test_groq():
    load_dotenv(override=True)
    keys = os.getenv("GROQ_API_KEY", "").split(",")
    key = keys[0].strip() if keys else ""
    client = Groq(api_key=key)
    try:
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": "hello"}],
            max_tokens=10
        )
        print("Success:", response.choices[0].message.content)
    except Exception as e:
        print("Error:", type(e), e)

if __name__ == "__main__":
    test_groq()