import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — getdatjob",
  description: "The terms governing your use of getdatjob.",
};

const LAST_UPDATED = "May 25, 2026";

export default function TermsPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        fontFamily: "var(--font-geist-sans), sans-serif",
        color: "var(--ink)",
      }}
    >
      {/* Nav */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 30,
          background: "rgba(244,240,232,.85)",
          backdropFilter: "saturate(140%) blur(10px)",
          borderBottom: "1px solid rgba(0,0,0,.04)",
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: "0 auto",
            padding: "0 28px",
            width: "100%",
            height: 62,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Link
            href="/"
            style={{
              fontFamily: "var(--font-geist-sans), sans-serif",
              fontWeight: 600,
              fontSize: 17,
              letterSpacing: "-0.015em",
              color: "var(--ink)",
            }}
          >
            getdatjob
          </Link>
          <Link
            href="/jobs"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 16px",
              borderRadius: 999,
              fontSize: 14,
              fontWeight: 500,
              background: "var(--ink)",
              color: "#F4F0E8",
              border: "1px solid transparent",
            }}
          >
            Get access
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" />
            </svg>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main
        style={{
          maxWidth: 760,
          margin: "0 auto",
          padding: "56px 24px 96px",
        }}
      >
        <p style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 12 }}>
          Last updated: {LAST_UPDATED}
        </p>
        <h1
          style={{
            fontFamily: "var(--font-instrument-serif), serif",
            fontSize: "clamp(32px, 6vw, 48px)",
            fontWeight: 400,
            letterSpacing: "-0.01em",
            color: "var(--ink)",
            margin: "0 0 48px",
            lineHeight: 1.15,
          }}
        >
          Terms of Service
        </h1>

        <Section title="1. Introduction">
          <p>
            getdatjob (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) operates a job board built for working visa holders in the United States. By accessing or using getdatjob.com and any related services (collectively, the &ldquo;Services&rdquo;), you agree to be bound by these Terms of Service (&ldquo;Terms&rdquo;).
          </p>
          <p>
            If you do not agree to these Terms, please do not use the Services.
          </p>
        </Section>

        <Section title="2. Service Description">
          <p>getdatjob provides:</p>
          <ul>
            <li>A curated job board of roles at employers with a demonstrated history of sponsoring U.S. work visas</li>
            <li>AI-powered job matching and filtering via our assistant, Kai</li>
            <li>Employer sponsorship data aggregated from public sources including the USCIS H-1B disclosure dataset</li>
            <li>Job alerts and search tools tailored to visa status and preferences</li>
            <li>Links to original job postings for direct application</li>
          </ul>
          <p>
            We are a discovery and research tool — we do not guarantee that any listed employer will sponsor your visa application, offer you employment, or that listed jobs are currently open.
          </p>
        </Section>

        <Section title="3. Eligibility and Account Registration">
          <p>
            You must be at least 18 years old to use the Services. By creating an account, you represent that all information you provide is accurate and that you will keep it up to date. You are responsible for maintaining the confidentiality of your login credentials and for all activity that occurs under your account.
          </p>
          <p>
            You may sign in using LinkedIn OAuth. By doing so, you authorize us to access certain LinkedIn profile data as described in our{" "}
            <Link href="/privacy" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              Privacy Policy
            </Link>
            .
          </p>
        </Section>

        <Section title="4. Accuracy of Sponsorship Data">
          <p>
            Our sponsorship data is derived from publicly available government records (e.g., USCIS H-1B disclosure data) and other open sources. This data reflects historical filings and may not represent an employer&rsquo;s current hiring practices, immigration policies, or visa sponsorship willingness.
          </p>
          <p>
            <strong>We do not verify, guarantee, or warrant that any employer listed on getdatjob is currently sponsoring visas or will sponsor your application.</strong> You must independently verify sponsorship availability by contacting employers directly.
          </p>
        </Section>

        <Section title="5. AI-Powered Features">
          <p>
            getdatjob includes AI-powered tools including our assistant Kai. AI analysis and recommendations are provided for informational purposes only and are not guaranteed to be accurate, complete, or suitable for your specific situation.
          </p>
          <p>
            You acknowledge that AI-generated content may contain errors or omissions. Do not rely solely on Kai or any AI feature for immigration, employment, or legal decisions. Consult a qualified immigration attorney for legal guidance.
          </p>
        </Section>

        <Section title="6. Prohibited Uses">
          <p>You agree not to:</p>
          <ul>
            <li>Scrape, crawl, or reproduce any content from getdatjob for commercial purposes without our written consent</li>
            <li>Reverse-engineer, decompile, or attempt to extract the source code of the platform or its AI models</li>
            <li>Share or sell your account credentials or access to any third party</li>
            <li>Use automated bots, scripts, or tools to access the Services beyond normal browser usage</li>
            <li>Submit false, misleading, or fraudulent information</li>
            <li>Attempt to disrupt, overload, or impair the platform&rsquo;s infrastructure</li>
            <li>Use the Services in any way that violates applicable federal, state, or local law</li>
          </ul>
        </Section>

        <Section title="7. Third-Party Content and Links">
          <p>
            The Services link to third-party job postings and employer websites. We do not control, endorse, or assume responsibility for any third-party content, products, or services. Your interactions with employers and third-party sites are solely between you and them.
          </p>
          <p>
            getdatjob is not a party to any employment relationship, visa sponsorship agreement, or application process between you and any employer.
          </p>
        </Section>

        <Section title="8. Intellectual Property">
          <p>
            All content on getdatjob — including text, graphics, logos, data compilations, and software — is owned by or licensed to getdatjob, Inc. and is protected by applicable intellectual property laws.
          </p>
          <p>
            You are granted a limited, non-exclusive, non-transferable license to access and use the Services for your personal, non-commercial job search. No other rights are granted.
          </p>
        </Section>

        <Section title="9. Privacy">
          <p>
            Your use of the Services is also governed by our{" "}
            <Link href="/privacy" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              Privacy Policy
            </Link>
            , which is incorporated into these Terms by reference. Please review it to understand how we collect, use, and protect your information.
          </p>
        </Section>

        <Section title="10. Service Availability">
          <p>
            We strive for high availability but cannot guarantee that the Services will be uninterrupted, error-free, or available at all times. We reserve the right to modify, suspend, or discontinue any part of the Services at any time, with or without notice.
          </p>
        </Section>

        <Section title="11. Disclaimer of Warranties">
          <p>
            THE SERVICES ARE PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. TO THE FULLEST EXTENT PERMITTED BY LAW, GETDATJOB DISCLAIMS ALL WARRANTIES, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
          </p>
          <p>
            WE DO NOT WARRANT THAT JOB LISTINGS ARE CURRENT, ACCURATE, OR COMPLETE; THAT ANY EMPLOYER WILL SPONSOR YOUR VISA; OR THAT THE SERVICES WILL MEET YOUR REQUIREMENTS.
          </p>
        </Section>

        <Section title="12. Limitation of Liability">
          <p>
            TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, GETDATJOB, INC. AND ITS OFFICERS, DIRECTORS, EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING FROM OR RELATING TO YOUR USE OF OR INABILITY TO USE THE SERVICES, INCLUDING BUT NOT LIMITED TO LOST EMPLOYMENT OPPORTUNITIES, VISA DENIAL, OR RELIANCE ON SPONSORSHIP DATA.
          </p>
          <p>
            IN NO EVENT SHALL OUR TOTAL LIABILITY TO YOU EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US IN THE TWELVE MONTHS PRIOR TO THE CLAIM OR (B) $50.
          </p>
        </Section>

        <Section title="13. Termination">
          <p>
            We may suspend or terminate your access to the Services at any time for violation of these Terms or for any other reason at our sole discretion. You may stop using the Services and delete your account at any time by contacting us at{" "}
            <a href="mailto:le.tiendat10@gmail.com" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              le.tiendat10@gmail.com
            </a>
            .
          </p>
          <p>
            Sections that by their nature should survive termination (including Disclaimers, Limitation of Liability, and Governing Law) will continue to apply after termination.
          </p>
        </Section>

        <Section title="14. Changes to These Terms">
          <p>
            We may update these Terms from time to time. When we do, we will revise the &ldquo;Last updated&rdquo; date at the top of this page. For material changes, we will notify you by email or by a prominent notice on the platform. Continued use of the Services after changes become effective constitutes your acceptance of the revised Terms.
          </p>
        </Section>

        <Section title="15. Governing Law">
          <p>
            These Terms are governed by the laws of the State of California, without regard to its conflict of law provisions. Any disputes arising under these Terms shall be resolved in the state or federal courts located in California.
          </p>
        </Section>

        <Section title="16. Contact Us" last>
          <p>
            If you have any questions about these Terms, please contact us:
          </p>
          <p>
            <strong>getdatjob, Inc.</strong>
            <br />
            <a href="mailto:le.tiendat10@gmail.com" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              le.tiendat10@gmail.com
            </a>
          </p>
        </Section>
      </main>

      {/* Minimal footer */}
      <footer
        style={{
          borderTop: "1px solid var(--line)",
          padding: "24px",
          textAlign: "center",
          fontSize: 13,
          color: "var(--ink-3)",
        }}
      >
        <p style={{ margin: 0 }}>
          © 2026 getdatjob, Inc.{" "}
          <Link href="/privacy" style={{ color: "var(--ink-3)", textDecoration: "underline" }}>
            Privacy
          </Link>
          {" · "}
          <Link href="/" style={{ color: "var(--ink-3)", textDecoration: "underline" }}>
            Home
          </Link>
        </p>
      </footer>
    </div>
  );
}

function Section({
  title,
  children,
  last,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section
      style={{
        borderTop: "1px solid var(--line)",
        paddingTop: 32,
        marginBottom: last ? 0 : 32,
      }}
    >
      <h2
        style={{
          fontSize: 17,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--ink)",
          margin: "0 0 16px",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          fontSize: 15,
          lineHeight: 1.75,
          color: "var(--ink-2)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {children}
      </div>
    </section>
  );
}
