import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

/*
  Appwrite Cloud Function entrypoint.
  - `context` is the Appwrite execution context containing request, env, logs, and response helpers.
  - This function reads a user's survey answers (or stored profile), filters career paths,
    calls Gemini to generate 5 tailored recommendations, updates the user doc, and returns JSON.

  Important notes:
  - This code runs in a serverless/cloud function environment — avoid relying on long-lived state.
  - Environment variables must be provided via the Appwrite function configuration.
*/
export default async function (context) {
  try {
    // -------------------------
    // Environment variables
    // -------------------------
    // Read from process.env (Appwrite populates these per-function)
    // Provide sensible fallbacks for collection/database ids used in development.
    const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
    const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
    const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const DATABASE_ID = process.env.DATABASE_ID || 'career4me';
    const TALENTS_COLLECTION_ID = process.env.TALENTS_COLLECTION_ID || 'talents';
    const CAREER_PATHS_COLLECTION_ID = process.env.CAREER_PATHS_COLLECTION_ID || 'careerPaths';

    // -------------------------
    // Parse incoming request payload
    // -------------------------
    // Expecting JSON body with { userId, surveyAnswers } when invoked via HTTP.
    // Use try/catch since context.req.body might be empty or not valid JSON.
    let userId = null;
    let surveyAnswers = null;
    try {
      const payload = JSON.parse(context.req.body || '{}');
      userId = payload.userId;
      surveyAnswers = payload.surveyAnswers;
    } catch (e) {
      // Non-fatal: we may obtain the userId from headers (session) instead.
      context.error('Failed to parse request payload:', e);
    }

    // -------------------------
    // Authentication: obtain userId from headers/session if not supplied
    // -------------------------
    // Appwrite sometimes provides user id via `x-appwrite-user-id` or an Authorization header.
    // This block attempts to resolve the user from an Appwrite session token if present.
    if (!userId) {
      try {
        if (context.req.headers['x-appwrite-user-id']) {
          // Direct header provided (trusted by Appwrite)
          userId = context.req.headers['x-appwrite-user-id'];
        } else if (context.req.headers['authorization']) {
          // If Authorization exists (Bearer <sessionId>), instantiate a Client and fetch the Account.
          // Note: Using Account.get() requires valid session; we set the session token on the client.
          const userClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID);

          const authHeader = context.req.headers['authorization'];
          if (authHeader.startsWith('Bearer ')) {
            const sessionId = authHeader.substring(7);
            // setSession is used to attach an existing session token to the client
            userClient.setSession(sessionId);

            // Import Account here to avoid top-level side-effects in some runtimes
            const { Account } = await import('node-appwrite');
            const userAccount = new Account(userClient);
            const user = await userAccount.get();
            userId = user.$id;
          }
        }
      } catch (authError) {
        // Authentication failure should not crash the function here; we'll fail later with a clear message.
        context.log('Auth error:', authError);
      }
    }

    // Log available environment and input state for troubleshooting
    context.log('Environment variables loaded:', {
      hasEndpoint: !!APPWRITE_ENDPOINT,
      hasProjectId: !!APPWRITE_PROJECT_ID,
      hasApiKey: !!APPWRITE_API_KEY,
      hasGeminiKey: !!GEMINI_API_KEY,
      userId: userId || 'not found',
      hasSurveyAnswers: !!surveyAnswers
    });

    // -------------------------
    // Validate essentials
    // -------------------------
    if (!APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY || !GEMINI_API_KEY) {
      context.error("Missing required environment variables", {
        APPWRITE_ENDPOINT: !!APPWRITE_ENDPOINT,
        APPWRITE_PROJECT_ID: !!APPWRITE_PROJECT_ID,
        APPWRITE_API_KEY: !!APPWRITE_API_KEY,
        GEMINI_API_KEY: !!GEMINI_API_KEY
      });
      throw new Error("Missing required environment variables");
    }

    if (!userId) {
      context.error("No user ID found in request context or payload");
      throw new Error("User authentication required");
    }

    // -------------------------
    // Initialize Appwrite client and Gemini
    // -------------------------
    const client = new Client()
      .setEndpoint(APPWRITE_ENDPOINT)
      .setProject(APPWRITE_PROJECT_ID)
      .setKey(APPWRITE_API_KEY);

    // Initialize Gemini client wrapper.
    // Note: The library usage here expects an API key and then retrieving a model handle.
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash",
      // Model-specific configuration commented out — keep as needed.
    });

    const databases = new Databases(client);

    context.log('Fetching user data for userId:', userId);

    // -------------------------
    // Fetch user document
    // -------------------------
    // We store users in the 'talents' collection and query by a 'talentId' field that maps to Appwrite user id.
    const user = await databases.listDocuments(
      DATABASE_ID,
      TALENTS_COLLECTION_ID,
      [Query.equal("talentId", userId)]
    );

    if (user.documents.length === 0) {
      context.error("User not found for userId:", userId);
      throw new Error("User not found");
    }

    const userData = user.documents[0];
    const careerStage = userData.careerStage;

    context.log('User data found:', {
      careerStage,
      currentPath: userData.currentPath,
      hasSurveyAnswers: !!surveyAnswers
    });

    // -------------------------
    // Fetch all career paths with pagination
    // -------------------------
    // Appwrite listDocuments is paginated — use limit+offset loop to ensure we retrieve all documents.
    // We break when a batch returns fewer documents than the limit (end of collection).
    let allCareerPaths = [];
    let offset = 0;
    const limit = 100; // batch size; adjust if Appwrite limits change
    
    do {
      const careerPathsBatch = await databases.listDocuments(
        DATABASE_ID,
        CAREER_PATHS_COLLECTION_ID,
        [Query.limit(limit), Query.offset(offset)]
      );
      
      allCareerPaths = allCareerPaths.concat(careerPathsBatch.documents);
      offset += limit;
      
      if (careerPathsBatch.documents.length < limit) {
        // No more pages
        break;
      }
    } while (true);

    if (allCareerPaths.length === 0) {
      context.error("No career paths found in database");
      throw new Error("No career paths found in database");
    }

    context.log('Total career paths found:', allCareerPaths.length);

    // -------------------------
    // Map survey answers to a normalized profile object
    // -------------------------
    // This function ensures fields are present and arrays are normalized for easier matching logic.
    const mapSurveyAnswersToProfile = (answers, careerStage, storedCurrentPath = null) => {
      const profile = {
        careerStage,
        education: '',
        program: '',
        currentSkills: [],
        interestedSkills: [],
        interests: [],
        interestedFields: [],
        workEnvironment: '',
        currentPath: storedCurrentPath || '', // fallback to stored path if survey omitted it
        yearsExperience: '',
        seniorityLevel: '',
        careerGoals: '',
        reasonForChange: '',
        changeUrgency: '',
        currentWorkEnvironment: '',
        preferredWorkEnvironment: ''
      };

      // Map common fields; guard against single-value answers by converting to arrays when appropriate.
      if (answers.educationLevel) profile.education = answers.educationLevel;
      if (answers.program) profile.program = answers.program;
      
      if (answers.currentSkills) {
        profile.currentSkills = Array.isArray(answers.currentSkills) 
          ? answers.currentSkills 
          : [answers.currentSkills];
      }
      if (answers.interestedSkills) {
        profile.interestedSkills = Array.isArray(answers.interestedSkills) 
          ? answers.interestedSkills 
          : [answers.interestedSkills];
      }
      if (answers.mainInterests) {
        profile.interests = Array.isArray(answers.mainInterests) 
          ? answers.mainInterests 
          : [answers.mainInterests];
      }
      if (answers.interestedFields) {
        profile.interestedFields = Array.isArray(answers.interestedFields) 
          ? answers.interestedFields 
          : [answers.interestedFields];
      }

      // Stage-specific mappings capture extra survey fields relevant to that cohort.
      if (careerStage === 'Pathfinder') {
        if (answers.workEnvironment) profile.workEnvironment = answers.workEnvironment;
      } else if (careerStage === 'Trailblazer') {
        if (answers.currentPath) profile.currentPath = answers.currentPath;
        if (answers.yearsExperience) profile.yearsExperience = answers.yearsExperience;
        if (answers.seniorityLevel) profile.seniorityLevel = answers.seniorityLevel;
        if (answers.careerGoals) profile.careerGoals = answers.careerGoals;
      } else if (careerStage === 'Horizon Changer') {
        if (answers.currentPath) profile.currentPath = answers.currentPath;
        if (answers.yearsExperience) profile.yearsExperience = answers.yearsExperience;
        if (answers.seniorityLevel) profile.seniorityLevel = answers.seniorityLevel;
        if (answers.currentWorkEnvironment) profile.currentWorkEnvironment = answers.currentWorkEnvironment;
        if (answers.preferredWorkEnvironment) profile.preferredWorkEnvironment = answers.preferredWorkEnvironment;
        if (answers.reasonForChange) profile.reasonForChange = answers.reasonForChange;
        if (answers.changeUrgency) profile.changeUrgency = answers.changeUrgency;
      }

      return profile;
    };

    // -------------------------
    // Build the working userProfile (either from survey or stored data)
    // -------------------------
    let userProfile;
    if (surveyAnswers && Object.keys(surveyAnswers).length > 0) {
      context.log('Using survey answers for recommendation');
      userProfile = mapSurveyAnswersToProfile(surveyAnswers, careerStage, userData.currentPath);
      
      // Build update payload for the talents collection so stored profile improves over time.
      // We avoid overwriting fields unnecessarily and only update when survey provides useful values.
      const updateData = {};
      
      // Example: store program/degree info in a `degrees` array unless it's a basic level (e.g., high school).
      if (surveyAnswers.educationLevel && !['High School', 'Some College'].includes(surveyAnswers.educationLevel)) {
        if (surveyAnswers.program && !updateData.degrees) updateData.degrees = [surveyAnswers.program];
      }
      if (surveyAnswers.currentSkills) {
        updateData.skills = Array.isArray(surveyAnswers.currentSkills) 
          ? surveyAnswers.currentSkills 
          : [surveyAnswers.currentSkills];
      }
      if (surveyAnswers.mainInterests) {
        updateData.interests = Array.isArray(surveyAnswers.mainInterests) 
          ? surveyAnswers.mainInterests 
          : [surveyAnswers.mainInterests];
      }
      if (surveyAnswers.interestedFields) {
        updateData.interestedFields = Array.isArray(surveyAnswers.interestedFields) 
          ? surveyAnswers.interestedFields 
          : [surveyAnswers.interestedFields];
      }
      if (surveyAnswers.currentPath) updateData.currentPath = surveyAnswers.currentPath;
      if (surveyAnswers.seniorityLevel) updateData.currentSeniorityLevel = surveyAnswers.seniorityLevel;
      
      // Persist updates if we have any meaningful changes; wrap in try/catch to avoid failing the whole flow.
      if (Object.keys(updateData).length > 0) {
        try {
          await databases.updateDocument(
            DATABASE_ID,
            TALENTS_COLLECTION_ID,
            userData.$id,
            updateData
          );
          context.log('Updated user profile with survey data');
        } catch (updateError) {
          // Non-fatal: log and continue — recommendations can still be generated with current data.
          context.log('Error updating user profile:', updateError);
        }
      }
    } else {
      // Use stored user profile fields when the user did not submit survey answers this request.
      context.log('Using stored user data for recommendation');
      userProfile = {
        careerStage,
        education: userData.degrees?.join(', ') || 'Not specified',
        currentSkills: userData.skills || [],
        interests: userData.interests || [],
        interestedFields: userData.interestedFields || [],
        currentPath: userData.currentPath || 'Not specified',
        seniorityLevel: userData.currentSeniorityLevel || 'Not specified'
      };
    }

    // -------------------------
    // Filtering & scoring career paths for relevance
    // -------------------------
    // This function performs fuzzy matching of interests/skills/industry to compute a relevance score.
    // It also applies heuristics per career stage:
    // - Trailblazer: strongly boost the user's current path to keep it as top recommendation.
    // - Horizon Changer: prefer candidates that are different from the current path (but still relevant).
    const filterRelevantCareerPaths = (careerPaths, userProfile) => {
      const relevantPaths = [];

      // Normalize user attributes for case-insensitive matching
      const userInterests = userProfile.interests.map(i => i.toLowerCase());
      const userFields = userProfile.interestedFields.map(f => f.toLowerCase());
      const userSkills = (userProfile.currentSkills || []).concat(userProfile.interestedSkills || []).map(s => s.toLowerCase());
      
      // Trailblazer special handling: try to find a direct match for currentPath among paths
      let currentPathMatch = null;
      if (careerStage === 'Trailblazer' && userProfile.currentPath && userProfile.currentPath !== 'Not specified') {
        currentPathMatch = careerPaths.find(path => 
          path.title.toLowerCase().includes(userProfile.currentPath.toLowerCase()) ||
          userProfile.currentPath.toLowerCase().includes(path.title.toLowerCase())
        );
        if (currentPathMatch) {
          context.log('Found current path match for Trailblazer:', currentPathMatch.title);
        }
      }
      
      for (const path of careerPaths) {
        let relevanceScore = 0;
        
        // Guarantee the current path surfaces for Trailblazers by giving a large boost.
        if (careerStage === 'Trailblazer' && currentPathMatch && path.$id === currentPathMatch.$id) {
          relevanceScore += 50; // large boost ensures top ranking
          context.log('Boosting current path for Trailblazer:', path.title);
        }
        
        // Interests matching: count overlap; use substring matching to catch partial matches.
        if (path.requiredInterests && Array.isArray(path.requiredInterests)) {
          const pathInterests = path.requiredInterests.map(i => i.toLowerCase());
          const interestMatches = pathInterests.filter(pi => 
            userInterests.some(ui => ui.includes(pi) || pi.includes(ui))
          ).length;
          relevanceScore += interestMatches * 3; // weight interests higher
        }
        
        // Skills matching: count overlap and weight slightly lower than interests.
        if (path.requiredSkills && Array.isArray(path.requiredSkills)) {
          const pathSkills = path.requiredSkills.map(s => s.toLowerCase());
          const skillMatches = pathSkills.filter(ps => 
            userSkills.some(us => us.includes(ps) || ps.includes(us))
          ).length;
          relevanceScore += skillMatches * 2;
        }
        
        // Industry/field match gives a modest bump
        if (path.industry) {
          const pathIndustry = path.industry.toLowerCase();
          if (userFields.some(uf => uf.includes(pathIndustry) || pathIndustry.includes(uf))) {
            relevanceScore += 4;
          }
        }
        
        // Degree/program compatibility check
        if (path.suggestedDegrees && Array.isArray(path.suggestedDegrees) && userProfile.program) {
          const userProgram = userProfile.program.toLowerCase();
          const degreeMatches = path.suggestedDegrees.some(deg => 
            deg.toLowerCase().includes(userProgram) || userProgram.includes(deg.toLowerCase())
          );
          if (degreeMatches) relevanceScore += 3;
        }
        
        // Horizon Changer gets a small boost for paths that differ from current
        if (careerStage === 'Horizon Changer' && userProfile.currentPath && userProfile.currentPath !== 'Not specified') {
          const isDifferentPath = !path.title.toLowerCase().includes(userProfile.currentPath.toLowerCase()) &&
                                !userProfile.currentPath.toLowerCase().includes(path.title.toLowerCase());
          if (isDifferentPath && relevanceScore > 0) {
            relevanceScore += 2;
          }
        }
        
        // Only include paths with some computed relevance to reduce noise.
        if (relevanceScore > 0) {
          relevantPaths.push({ ...path, relevanceScore });
        }
      }
      
      // Sort by relevance descending
      relevantPaths.sort((a, b) => b.relevanceScore - a.relevanceScore);
      
      // If not enough relevant results, add random variety so AI has examples to consider.
      // This prevents the model from only seeing a tiny pool when relevance is scarce.
      if (relevantPaths.length < 15) {
        const remainingPaths = careerPaths.filter(path => 
          !relevantPaths.some(rp => rp.$id === path.$id)
        );
        const randomPaths = remainingPaths
          .sort(() => Math.random() - 0.5)
          .slice(0, 15 - relevantPaths.length)
          .map(path => ({ ...path, relevanceScore: 0 }));
        relevantPaths.push(...randomPaths);
      }
      
      // Return a reasonable number (25) for the AI prompt to consider — balances variety vs prompt size.
      return relevantPaths.slice(0, 25);
    };

    context.log('Filtering relevant career paths...');
    const filteredCareerPaths = filterRelevantCareerPaths(allCareerPaths, userProfile);
    context.log('Filtered career paths:', filteredCareerPaths.length);

    // -------------------------
    // Compose the prompt for the Gemini model
    // -------------------------
    // The prompt includes:
    // - Career stage-specific instructions (e.g., Trailblazer constraints)
    // - Normalized user profile details
    // - A pre-filtered list of candidate career paths including metadata (skills, interests, degrees)
    // We explicitly request JSON output to simplify parsing.
    let prompt = `Based on the following user profile, recommend the top 5 career paths from the provided list. `;
    
    if (careerStage === "Pathfinder") {
      prompt += `User is a Pathfinder (someone exploring career options). Focus on providing diverse entry-level opportunities that match their interests and potential.\n\n`;
    } else if (careerStage === "Trailblazer") {
      prompt += `User is a Trailblazer (someone advancing in their current field). IMPORTANT: Their current path should be the #1 recommendation with the highest match score (95-100%) as they want to advance in their existing career. The other 4 recommendations should be related or complementary paths.\n\n`;
    } else if (careerStage === "Horizon Changer") {
      prompt += `User is a Horizon Changer (someone looking to change careers). Focus on diverse alternatives that leverage their existing skills while offering new challenges. Their current path can be included but should not dominate the recommendations.\n\n`;
    }

    // Append user details tailored to the career stage to reduce prompt verbosity while keeping necessary context.
    if (careerStage === "Pathfinder") {
      prompt += `User details:
      - Education: ${userProfile.education || 'Not specified'}
      - Program: ${userProfile.program || 'Not specified'}
      - Current Skills: ${userProfile.currentSkills.join(', ') || 'Not specified'}
      - Interested Skills: ${userProfile.interestedSkills.join(', ') || 'Not specified'}
      - Interests: ${userProfile.interests.join(', ') || 'Not specified'}
      - Interested Fields: ${userProfile.interestedFields.join(', ') || 'Not specified'}
      - Preferred Work Environment: ${userProfile.workEnvironment || 'Not specified'}
      `;
    } else if (careerStage === "Trailblazer") {
      prompt += `User details:
      - Current Path: ${userProfile.currentPath || 'Not specified'}
      - Years of Experience: ${userProfile.yearsExperience || 'Not specified'}
      - Seniority Level: ${userProfile.seniorityLevel || 'Not specified'}
      - Education: ${userProfile.education || 'Not specified'}
      - Program: ${userProfile.program || 'Not specified'}
      - Current Skills: ${userProfile.currentSkills.join(', ') || 'Not specified'}
      - Interested Skills: ${userProfile.interestedSkills.join(', ') || 'Not specified'}
      - Interests: ${userProfile.interests.join(', ') || 'Not specified'}
      - Interested Fields: ${userProfile.interestedFields.join(', ') || 'Not specified'}
      - Career Goals: ${userProfile.careerGoals || 'Not specified'}
      `;
    } else if (careerStage === "Horizon Changer") {
      prompt += `User details:
      - Current Path: ${userProfile.currentPath || 'Not specified'}
      - Years of Experience: ${userProfile.yearsExperience || 'Not specified'}
      - Seniority Level: ${userProfile.seniorityLevel || 'Not specified'}
      - Education: ${userProfile.education || 'Not specified'}
      - Program: ${userProfile.program || 'Not specified'}
      - Current Skills: ${userProfile.currentSkills.join(', ') || 'Not specified'}
      - Interested Skills: ${userProfile.interestedSkills.join(', ') || 'Not specified'}
      - Interests: ${userProfile.interests.join(', ') || 'Not specified'}
      - Interested Fields: ${userProfile.interestedFields.join(', ') || 'Not specified'}
      - Current Work Environment: ${userProfile.currentWorkEnvironment || 'Not specified'}
      - Preferred Work Environment: ${userProfile.preferredWorkEnvironment || 'Not specified'}
      - Reason for Change: ${userProfile.reasonForChange || 'Not specified'}
      - Change Urgency: ${userProfile.changeUrgency || 'Not specified'}
      `;
    }

    // Attach the list of candidate career paths. We include key metadata to help the model make informed matches.
    prompt += `\nAvailable Career Paths (pre-filtered for relevance):\n`;
    filteredCareerPaths.forEach(path => {
      prompt += `- ${path.title} (ID: ${path.$id})\n`;
      prompt += `  Industry: ${path.industry || 'Not specified'}\n`;
      prompt += `  Description: ${path.description || 'No description'}\n`;
      prompt += `  Required Skills: ${path.requiredSkills?.join(', ') || 'None specified'}\n`;
      prompt += `  Required Interests: ${path.requiredInterests?.join(', ') || 'None specified'}\n`;
      prompt += `  Suggested Degrees: ${path.suggestedDegrees?.join(', ') || 'None specified'}\n`;
      prompt += `  Salary Range: ${path.minSalary && path.maxSalary ? `$${path.minSalary} - $${path.maxSalary}` : 'Not specified'}\n`;
      if (path.relevanceScore) prompt += `  Relevance Score: ${path.relevanceScore}\n`;
      prompt += `\n`;
    });

    // Provide stage-specific constraints and final JSON schema instructions.
    if (careerStage === "Trailblazer") {
      prompt += `\nCRITICAL INSTRUCTIONS FOR TRAILBLAZER:
      1. The user's current path "${userProfile.currentPath}" should be the #1 recommendation with match score 95-100%
      2. Find the career path that most closely matches their current path and make it the top recommendation
      3. The remaining 4 recommendations should be advancement opportunities or specializations within their field
      4. Focus on career growth and skill development in their existing domain
      `;
    } else if (careerStage === "Horizon Changer") {
      prompt += `\nINSTRUCTIONS FOR HORIZON CHANGER:
      1. Prioritize paths that leverage their existing skills but offer new challenges
      2. Consider their reason for change: ${userProfile.reasonForChange}
      3. Focus on transferable skills from their current path: ${userProfile.currentPath}
      4. Provide diverse options across different industries/roles
      `;
    } else {
      prompt += `\nINSTRUCTIONS FOR PATHFINDER:
      1. Focus on entry-level opportunities that match their interests and education
      2. Provide diverse options across different industries and skill requirements
      3. Consider their preferred work environment and interests
      `;
    }

    prompt += `\nProvide your response in JSON format with this structure:
    {
      "recommendations": [
        {
          "pathId": "career_path_id_1",
          "title": "Career Path Title 1",
          "matchScore": 90,
          "reason": "Explain why this path matches using personal pronouns like 'you' and 'your'. For example: 'This role aligns well with your interest in X and your strong background in Y. Your experience with Z makes you particularly well-suited for this path.'",
          "improvementAreas": ["skill1", "skill2"]
        },
        // ... 4 more recommendations
      ],
      "generalAdvice": "Career stage-specific advice addressing the user directly using 'you' and 'your'. This advice must be a bit into depth using some answers from their survey but not too long. Max 3 lines."
    }`;

    context.log('Calling Gemini AI...');

    // -------------------------
    // Call Gemini model
    // -------------------------
    // Note: model.generateContent and response.text() are async — ensure proper awaits.
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    context.log('Gemini AI response received, length:', text.length);

    // -------------------------
    // Parse JSON from AI response
    // -------------------------
    // Many LLM responses include backticks or markdown fences; strip them before JSON.parse.
    // If parse fails, attempt a regex extraction of the first JSON object found.
    let jsonResponse;
    try {
      const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      jsonResponse = JSON.parse(cleanedText);
    } catch (e) {
      // Log full text for debugging then try to recover using a best-effort regex to extract JSON
      context.error("Failed to parse AI response:", text);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          jsonResponse = JSON.parse(jsonMatch[0]);
        } catch (e2) {
          // If still failing, raise a clear error so caller knows the AI response could not be interpreted.
          throw new Error("Failed to parse AI response as JSON");
        }
      } else {
        throw new Error("No valid JSON found in AI response");
      }
    }

    // Validate response shape
    if (!jsonResponse.recommendations || !Array.isArray(jsonResponse.recommendations)) {
      context.error("Invalid response structure from AI:", jsonResponse);
      throw new Error("Invalid response structure from AI");
    }

    // Ensure we have at least 5 recommendations (fail early if not)
    if (jsonResponse.recommendations.length < 5) {
      context.error("AI did not provide enough recommendations:", jsonResponse.recommendations.length);
      throw new Error("AI did not provide enough recommendations");
    }

    context.log('Updating user testTaken status...');

    // -------------------------
    // Mark that user has taken the test
    // -------------------------
    // This is a simple flag update; keep it atomic and minimal.
    await databases.updateDocument(
      DATABASE_ID,
      TALENTS_COLLECTION_ID,
      userData.$id,
      {
        testTaken: true
      }
    );

    // -------------------------
    // Construct API response
    // -------------------------
    const responseData = {
      success: true,
      recommendations: jsonResponse.recommendations.slice(0, 5), // ensure exactly top 5
      generalAdvice: jsonResponse.generalAdvice || `Continue developing your skills and exploring opportunities in your areas of interest as a ${careerStage}.`,
      careerStage,
      totalPathsConsidered: allCareerPaths.length,
      filteredPathsConsidered: filteredCareerPaths.length,
      userCurrentPath: userProfile.currentPath
    };

    context.log('Career match completed successfully - Total paths:', allCareerPaths.length, 'Filtered paths:', filteredCareerPaths.length, 'Career stage:', careerStage);

    // Return standard Appwrite-compatible JSON response
    return context.res.json(responseData);

  } catch (error) {
    // Centralized error handling: log with context and return a structured error payload.
    context.error("Error in careerMatch function:", error);
    
    const errorResponse = {
      success: false,
      error: error.message || "An unknown error occurred"
    };
    
    return context.res.json(errorResponse);
  }
}