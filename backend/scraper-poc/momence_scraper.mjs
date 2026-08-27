import puppeteer from 'puppeteer';
import fs from 'fs';
import 'dotenv/config';

const MOMENCE_EMAIL = process.env.MOMENCE_EMAIL;
const MOMENCE_PASSWORD = process.env.MOMENCE_PASSWORD;

// --- ROBUST DEBUGGING UTILITY ---
async function debugCrash(page, stepName, error) {
    console.log(`\n--- 🚨 CRASH AT STEP: ${stepName} ---`);
    console.log(`ERROR MESSAGE: ${error.message}`);
    
    if (page) {
        try {
            console.log(`CURRENT URL: ${page.url()}`);
            const safeName = stepName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            
            await page.screenshot({ path: `debug_${safeName}.png`, fullPage: true });
            console.log(`📸 Saved screenshot to: debug_${safeName}.png`);
            
            const html = await page.content();
            fs.writeFileSync(`debug_${safeName}.html`, html);
            console.log(`📄 Saved HTML DOM to: debug_${safeName}.html`);
        } catch (debugErr) {
            console.error("⚠️ Failed to generate debug files:", debugErr.message);
        }
    }
    console.log(`------------------------------------\n`);
    process.exit(1);
}

async function scrapeMomenceSchedule() {
    if (!MOMENCE_EMAIL || !MOMENCE_PASSWORD) {
        console.error("ERROR: Please provide MOMENCE_EMAIL and MOMENCE_PASSWORD in a .env file.");
        process.exit(1);
    }

    console.log(`🚀 Booting up Local Puppeteer (Linux Safe Mode)...`);
    
    const browser = await puppeteer.launch({ 
        headless: false, 
        defaultViewport: null, 
        args: [
            '--start-maximized',
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ] 
    });

    let page;

    try {
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        console.log("🌐 Navigating to Momence Sign-In...");
        try {
            await page.goto('https://momence.com/sign-in', { waitUntil: 'networkidle2', timeout: 30000 });
        } catch (err) {
            console.log(`⚠️ Navigation event, waiting for inputs...`);
        }

        console.log("🔑 Entering credentials...");
        try {
            await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
        } catch (err) {
            await debugCrash(page, "Login_Input_Wait", err);
        }
        
        const emailInput = await page.$('input[type="email"], input[name="email"]');
        const passwordInput = await page.$('input[type="password"], input[name="password"]');

        await emailInput.type(MOMENCE_EMAIL, { delay: 50 });
        await passwordInput.type(MOMENCE_PASSWORD, { delay: 50 });

        console.log("🖱️ Submitting login form...");
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            page.keyboard.press('Enter')
        ]);

        console.log("⏳ Waiting for user dashboard to load...");
        try {
            await page.waitForSelector('a[href*="/u/"]', { timeout: 15000 });
        } catch (err) {
            await debugCrash(page, "Dashboard_Studio_Links", err);
        }

        const studioLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const studioAnchors = links.filter(a => a.href && a.href.includes('/u/') && !a.href.includes('/dashboard') && !a.href.includes('/login'));
            return [...new Set(studioAnchors.map(a => a.href))];
        });

        if (studioLinks.length === 0) {
            console.log("⚠️ No studio links found. Exiting.");
            process.exit(1);
        }

        console.log(`🎯 Found ${studioLinks.length} studios. Scraping locally...`);
        const allScrapedClasses = [];

        for (const link of studioLinks) {
            console.log(`\n🌐 Navigating to Studio: ${link}`);
            
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
                
                await page.waitForFunction(
                    () => /\d{1,2}:\d{2}\s*(AM|PM|am|pm)/i.test(document.body.innerText), 
                    { timeout: 8000 }
                ).catch(() => {});
                await new Promise(resolve => setTimeout(resolve, 1000)); 

                let rawStudioTitle = link.split('/').pop();
                rawStudioTitle = rawStudioTitle.replace(/[-,\s]+[a-zA-Z0-9]{6}$/, '');
                rawStudioTitle = rawStudioTitle.replace(/[-,\s]+$/, '');
                const formattedStudio = rawStudioTitle.replace(/-/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

                const safeFileName = formattedStudio.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                const htmlContent = await page.content();
                fs.writeFileSync(`studio_${safeFileName}.html`, htmlContent);
                console.log(`💾 Saved full DOM HTML to studio_${safeFileName}.html`);

                // --- DIRECT DOM PARSER EXTRACTING BOOKING URL ---
                const scrapedClasses = await page.evaluate((formattedStudio, studioUrl) => {
                    const sessions = [];
                    const articles = document.querySelectorAll('article[data-session_id], article');

                    articles.forEach((el, index) => {
                        // 1. Extract Title
                        const titleEl = el.querySelector('.momence-host_schedule-session_list-item-title');
                        if (!titleEl) return;
                        let className = titleEl.innerText.trim();

                        // 2. Extract Teacher
                        const teacherEl = el.querySelector('.momence-session-teacher');
                        let instructor = "Instructor";
                        if (teacherEl) {
                            instructor = teacherEl.innerText
                                .replace(/Show bio/gi, '')
                                .replace(/\n/g, ' ')
                                .trim();
                        }

                        // 3. Extract Date
                        const dateEl = el.querySelector('.momence-session-starts_at');
                        let cardDate = dateEl ? dateEl.innerText.replace(/\n/g, ' ').trim() : "";

                        // 4. Extract Start Time (first match only)
                        const durationEl = el.querySelector('.momence-session-duration');
                        let startTime = "Upcoming";
                        if (durationEl) {
                            const timeMatches = durationEl.innerText.match(/\d{1,2}:\d{2}\s*(AM|PM|am|pm)/i);
                            if (timeMatches) {
                                startTime = timeMatches[0].toUpperCase();
                            }
                        }

                        // 5. Extract Direct Booking URL
                        const sessionId = el.getAttribute('data-session_id');
                        let bookingUrl = studioUrl;

                        if (sessionId) {
                            bookingUrl = `https://momence.com/s/${sessionId}?skipPreview=true`;
                        } else {
                            const anchor = el.querySelector('a[href*="/s/"], a[href*="/e/"], a[href*="/checkout/"]');
                            if (anchor && anchor.href) {
                                bookingUrl = anchor.href;
                            }
                        }

                        // 6. Check if Online
                        const isOnline = el.querySelector('.momence-session-online') !== null || className.toLowerCase().includes('online');
                        if (isOnline && !className.toLowerCase().includes('(online)')) {
                            className = `(Online) ${className}`;
                        }

                        if (cardDate && startTime !== "Upcoming") {
                            sessions.push({
                                id: sessionId ? `mo_${sessionId}` : `mo_studio_${index}_${Math.random().toString(36).substring(7)}`,
                                source: 'momence',
                                studioName: formattedStudio,
                                dateString: cardDate,
                                className: className,
                                instructor: instructor,
                                timeString: `${cardDate} - ${startTime}`,
                                bookingUrl: bookingUrl,
                                isOnline: isOnline
                            });
                        }
                    });

                    // Deduplicate
                    const uniqueSessions = [];
                    const seen = new Set();
                    for (const s of sessions) {
                        const key = s.id.startsWith('mo_studio_') 
                            ? `${s.className}-${s.timeString}-${s.studioName}`
                            : s.id;

                        if (!seen.has(key)) {
                            seen.add(key);
                            uniqueSessions.push(s);
                        }
                    }

                    return uniqueSessions;
                }, formattedStudio, link);

                allScrapedClasses.push(...scrapedClasses);
                console.log(`✅ Extracted ${scrapedClasses.length} classes from ${formattedStudio}`);
                
            } catch (err) {
                console.log(`❌ Soft Error scraping ${link}: ${err.message}. Continuing...`);
            }
        }

        console.log(`\n✨ Successfully scraped ${allScrapedClasses.length} total classes!`);
        console.log(JSON.stringify(allScrapedClasses, null, 2));

    } catch (error) {
        await debugCrash(page, "Fatal_Execution", error);
    } finally {
        if (browser) await browser.close();
    }
}

scrapeMomenceSchedule();