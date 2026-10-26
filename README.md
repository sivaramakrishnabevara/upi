🚀 Automated UPI Transaction Bot📌 OverviewThe Automated UPI Transaction Bot is a high-performance backend service designed to securely scrape, monitor, and automate UPI transaction details. Built using FastAPI for robust API routing and Playwright for headless browser automation, this bot extracts transaction data in real-time and triggers instant notifications (e.g., via Telegram).✨ FeaturesFast & Asynchronous: Built on FastAPI for lightning-fast API responses.Headless Automation: Utilizes Playwright to navigate and scrape transaction portals securely without manual intervention.Real-time Alerts: Automatically pushes transaction updates and alerts.Secure Data Handling: Ensures data is scraped and processed securely in the backend.RESTful API Design: Clean and well-documented API endpoints for easy integration with front-end applications or other microservices.🛠️ Tech StackLanguage: Python 3.9+Framework: FastAPIAutomation Tool: PlaywrightServer: UvicornNotifications: Telegram Bot API (Optional integration)⚙️ Installation & Setup1. Clone the repository:git clone https://github.com/sivaramakrishnabevara/upi-transaction-bot.git
cd upi-transaction-bot
2. Create a Virtual Environment:python -m venv venv
source venv/bin/activate  # On Windows use: venv\Scripts\activate
3. Install Dependencies:pip install -r requirements.txt
4. Install Playwright Browsers:playwright install
🚀 Usage1. Set up Environment Variables:
Create a .env file in the root directory and add your credentials:PORTAL_USERNAME=your_username
PORTAL_PASSWORD=your_password
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id
2. Run the FastAPI Server:uvicorn main:app --reload
The API will be available at http://localhost:8000. You can view the interactive Swagger documentation at http://localhost:8000/docs.📡 API EndpointsMethodEndpointDescriptionGET/Health check to see if the bot is runningPOST/scrape-transactionsTriggers Playwright to scrape the latest UPI transactionsGET/get-historyFetches the saved transaction history⚠️ DisclaimerEducational Purposes Only: This project was developed to demonstrate backend automation, web scraping, and API development skills. Scraping financial or banking portals should only be done with explicit permission and in compliance with the portal's Terms of Service.👨‍💻 AuthorSiva Rama Krishna Bevara
